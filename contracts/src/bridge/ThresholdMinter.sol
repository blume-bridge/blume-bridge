// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC5267} from "@openzeppelin/contracts/interfaces/IERC5267.sol";
import {BridgeToken} from "./BridgeToken.sol";
import {TokenFactory} from "./TokenFactory.sol";

/// @title ThresholdMinter
/// @notice The EVM half of the Blume Bridge's custody. A fixed signer set of
///         n operator keys; most actions need k EIP-712 signatures from
///         distinct signers, given in ascending signer address order. There is
///         no owner and no upgrade path: what is deployed here is what runs.
///
///         What each action needs
///         - mint: k signatures over the token, the recipient, the amount and
///           the XRP Ledger lock transaction. One lock mints once.
///         - listToken, updateToken: k signatures. A token's name, symbol, logo
///           and daily cap change only through an update signed over the
///           token's next `metaNonce`, which rises by exactly one per update:
///           a signed update is good for one call, and an old one can never
///           roll a newer one back.
///         - proposeRotation, cancelRotation: k signatures. The signer set
///           rotates only through a signed proposal that waits out a delay,
///           and every proposal or cancel signs the current `proposalSeq`, so
///           a signed message is good for one call. executeRotation needs no
///           signature once the delay has passed.
///         - setBurnFee, sweep, resume: k signatures, each over its own nonce.
///         - pause: one current signer, no signature.
///         - burn (on the token): the holder, who pays the exit fee.
///
///         Daily cap. Each token has a mint cap per UTC day (a calendar
///         bucket that resets at midnight UTC, not a rolling window; the
///         cluster mirrors the same rule). A cap of 0 means the token takes no
///         mints, until an update raises it. `UNCAPPED` (the largest uint256)
///         means no limit. Lowering a cap counts what was already minted that
///         day.
///
///         Exit fee. Burning a token pays `burnFee` in native XRP, exactly,
///         and the token passes it on to this contract. Only tokens this
///         contract listed can send XRP in. The balance is fee revenue and
///         nothing else: what backs the tokens is on the XRP Ledger. k
///         signers set the fee, never above `MAX_BURN_FEE`, and k signers pay
///         the balance out with `sweep`.
///
///         Mint pause. One current signer can pause, so one operator who sees
///         a problem can stop new mints at once; it takes k signers to resume,
///         so one lost or hostile key can stop mints (again after every
///         resume, until a rotation removes it) but can never restart them or
///         move funds. Pausing stops `mint` and nothing else: burns,
///         listings, updates (so a cap can still be lowered), fee changes,
///         sweeps and rotations all keep working, so holders can always leave
///         and a bad signer set can always be rotated out.
///
///         Signed messages never expire. Each is good for exactly one call,
///         whenever it is sent, until its nonce is spent (a mint until its
///         lock has minted, an update until the token's `metaNonce` moves,
///         and so on). Operators should sign a resume, a sweep or a fee
///         change only when it is about to be sent.
/// @dev    EIP-712 domain "BlumeBridge", version "3". Version 1 signed a List
///         without imageURI, version 2 added the logo and signed updates, and
///         version 3 added the exit fee, sweeps, the pause and the meaning of
///         a cap of 0. A bump means no signature made for an older minter ever
///         verifies here. The domain also binds the chain and this contract's
///         address, so one minter's signatures never verify on another.
///         The domain is written out below rather than inherited from
///         OpenZeppelin's EIP712: that base imports Strings and Bytes, whose
///         `mcopy` makes a shanghai recompile fail, and a shanghai recompile is
///         how source gets verified on this chain's explorer
///         (docs/CONTRACT_VERIFICATION.md).
contract ThresholdMinter is IERC5267 {
    // ------------------------------------------------------------ types

    struct Mint {
        bytes32 tokenId;
        address to;
        uint256 amount;
        bytes32 srcTx;
    }

    struct Listing {
        bytes32 tokenId;
        string name;
        string symbol;
        /// @dev The logo URI. May be empty.
        string imageURI;
        /// @dev Mint cap per UTC day, in token units. 0 means no mints until an update raises it; `UNCAPPED` means no limit.
        uint256 dailyCap;
    }

    struct Update {
        bytes32 tokenId;
        string name;
        string symbol;
        /// @dev The logo URI. May be empty.
        string imageURI;
        /// @dev Replaces the cap from now on, within the current UTC day too. 0 means no mints; `UNCAPPED` means no limit.
        uint256 dailyCap;
        /// @dev Must equal `metaNonce[tokenId] + 1`.
        uint256 nonce;
    }

    struct Rotation {
        address[] signers;
        uint8 threshold;
        /// @dev Must equal `rotationNonce`: the number of rotations executed so far.
        uint256 nonce;
        /// @dev Must equal `proposalSeq`: bumps on every proposal and cancel, so the same signatures cannot be resubmitted.
        uint256 seq;
    }

    struct Fee {
        /// @dev The new exit fee in wei of XRP. At most `MAX_BURN_FEE`; 0 switches the fee off.
        uint256 burnFee;
        /// @dev Must equal `feeNonce`: the number of fee changes so far.
        uint256 nonce;
    }

    struct Sweep {
        /// @dev Who is paid. 1 to `MAX_SWEEP_ENTRIES` entries, none the zero address.
        address[] to;
        /// @dev What each is paid in wei of XRP, one per entry of `to`.
        uint256[] amounts;
        /// @dev Must equal `sweepNonce`: the number of sweeps so far.
        uint256 nonce;
    }

    struct Cap {
        uint256 perDay;
        uint256 used;
        uint256 day;
    }

    bytes32 public constant MINT_TYPEHASH = keccak256("Mint(bytes32 tokenId,address to,uint256 amount,bytes32 srcTx)");
    bytes32 public constant LIST_TYPEHASH = keccak256("List(bytes32 tokenId,string name,string symbol,string imageURI,uint256 dailyCap)");
    bytes32 public constant UPDATE_TYPEHASH =
        keccak256("Update(bytes32 tokenId,string name,string symbol,string imageURI,uint256 dailyCap,uint256 nonce)");
    bytes32 public constant ROTATE_TYPEHASH = keccak256("Rotate(address[] signers,uint8 threshold,uint256 nonce,uint256 seq)");
    bytes32 public constant CANCEL_TYPEHASH = keccak256("Cancel(bytes32 rotation,uint256 seq)");
    bytes32 public constant SET_BURN_FEE_TYPEHASH = keccak256("SetBurnFee(uint256 burnFee,uint256 nonce)");
    bytes32 public constant SWEEP_TYPEHASH = keccak256("Sweep(address[] to,uint256[] amounts,uint256 nonce)");
    bytes32 public constant RESUME_TYPEHASH = keccak256("Resume(uint256 nonce)");

    bytes32 private constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    string private constant DOMAIN_NAME = "BlumeBridge";
    string private constant DOMAIN_VERSION = "3";

    /// @notice A daily cap of this value means no limit. A cap of 0 means no mints.
    uint256 public constant UNCAPPED = type(uint256).max;
    /// @notice The exit fee can never be set above this: leaving can never be priced out. 1 XRP.
    uint256 public constant MAX_BURN_FEE = 1 ether;
    /// @notice The most payouts one sweep can carry.
    uint256 public constant MAX_SWEEP_ENTRIES = 32;

    // Byte-length bounds on what a listing or update writes into a token.
    uint256 private constant MAX_NAME_BYTES = 64;
    uint256 private constant MAX_SYMBOL_BYTES = 32;
    uint256 private constant MAX_IMAGE_URI_BYTES = 256;

    // ------------------------------------------------------------ state

    TokenFactory public immutable factory;
    uint256 public immutable rotationDelay;

    address[] private _signers;
    mapping(address => bool) public isSigner;
    uint8 public threshold;

    mapping(bytes32 => address) public tokens;
    /// @notice True for every token this minter listed, and only those: the only senders `receive` accepts.
    mapping(address => bool) public isToken;
    mapping(address => Cap) public caps;
    mapping(bytes32 => bool) public minted;
    /// @notice Per token: the number of updates applied so far. The next update must carry this plus one.
    mapping(bytes32 => uint256) public metaNonce;

    uint256 public rotationNonce;
    /// @notice Bumps on every proposeRotation and cancelRotation; part of both digests.
    uint256 public proposalSeq;
    bytes32 public pendingRotation;
    uint256 public pendingRotationAt;
    address[] private _pendingSigners;
    uint8 private _pendingThreshold;

    /// @notice The XRP a burn must carry, in wei. Changes only through `setBurnFee`.
    uint256 public burnFee;
    /// @notice The number of fee changes so far; the next `setBurnFee` must carry it.
    uint256 public feeNonce;
    /// @notice The number of sweeps so far; the next `sweep` must carry it.
    uint256 public sweepNonce;

    /// @notice True while mints are paused.
    bool public paused;
    /// @notice The number of resumes so far; the next `resume` must carry it.
    uint256 public resumeNonce;

    // ------------------------------------------------------------ events

    event Listed(bytes32 indexed tokenId, address indexed token, string name, string symbol, string imageURI, uint256 dailyCap);
    event Updated(bytes32 indexed tokenId, address indexed token, string name, string symbol, string imageURI, uint256 dailyCap, uint256 nonce);
    event Minted(bytes32 indexed tokenId, address indexed to, uint256 amount, bytes32 indexed srcTx);
    event RotationProposed(bytes32 indexed rotation, address[] signers, uint8 threshold, uint256 executableAt);
    event RotationExecuted(address[] signers, uint8 threshold);
    event RotationCancelled(bytes32 indexed rotation);
    event BurnFeeSet(uint256 oldFee, uint256 newFee);
    event Swept(address[] to, uint256[] amounts, uint256 nonce);
    event Paused(address by);
    event Resumed(uint256 nonce);

    error BadSignerSet();
    error NotEnoughSignatures();
    error BadSignature();
    error SignersNotSorted();
    error UnknownToken();
    error TokenExists();
    error AlreadyMinted();
    error CapExceeded();
    error NoPendingRotation();
    error RotationNotReady();
    error BadNonce();
    error BadSeq();
    error BadMetadata();
    /// @dev A burn fee above `MAX_BURN_FEE`.
    error BadFee();
    /// @dev XRP sent here by anything but a token this minter listed.
    error NotToken();
    /// @dev A sweep with no entries, more than `MAX_SWEEP_ENTRIES`, unequal arrays, or a zero address.
    error BadSweep();
    /// @dev A sweep payment was refused or the balance could not cover it; nothing was paid.
    error SweepFailed();
    /// @dev Mints are paused. The cluster holds the mint and retries after a resume.
    error IsPaused();
    error AlreadyPaused();
    error NotPaused();
    /// @dev `pause` from an address that is not a current signer.
    error NotSigner();

    // ------------------------------------------------------------ setup

    constructor(address[] memory signers_, uint8 threshold_, uint256 rotationDelay_, uint256 burnFee_) {
        if (burnFee_ > MAX_BURN_FEE) revert BadFee();
        _setSigners(signers_, threshold_);
        factory = new TokenFactory(address(this));
        rotationDelay = rotationDelay_;
        burnFee = burnFee_;
    }

    /// @notice Takes the exit fee a listed token passes on when it burns. Nothing else may send XRP here.
    receive() external payable {
        if (!isToken[msg.sender]) revert NotToken();
    }

    function signers() external view returns (address[] memory) {
        return _signers;
    }

    // ------------------------------------------------------------ listing

    /// @notice Deploys the ERC-20 for a listing that k operators signed, with its name, symbol and logo.
    ///         A daily cap of 0 lists the token with no mints until an update raises it.
    function listToken(Listing calldata l, bytes[] calldata sigs) external returns (address token) {
        if (tokens[l.tokenId] != address(0)) revert TokenExists();
        _checkMetadata(l.name, l.symbol, l.imageURI);
        bytes32 structHash = keccak256(
            abi.encode(LIST_TYPEHASH, l.tokenId, keccak256(bytes(l.name)), keccak256(bytes(l.symbol)), keccak256(bytes(l.imageURI)), l.dailyCap)
        );
        _verify(_hashTypedData(structHash), sigs);
        token = factory.deploy(l.name, l.symbol, l.imageURI);
        tokens[l.tokenId] = token;
        isToken[token] = true;
        caps[token] = Cap({perDay: l.dailyCap, used: 0, day: block.timestamp / 1 days});
        emit Listed(l.tokenId, token, l.name, l.symbol, l.imageURI, l.dailyCap);
    }

    /// @notice Changes a listed token's name, symbol, logo and daily cap, once k operators signed the update.
    ///         The update carries the token's next `metaNonce`, so it applies once and nothing older can follow it.
    ///         The new cap counts what was already minted today: a lower cap can stop further mints until midnight UTC.
    ///         Works while mints are paused.
    function updateToken(Update calldata u, bytes[] calldata sigs) external {
        address token = tokens[u.tokenId];
        if (token == address(0)) revert UnknownToken();
        if (u.nonce != metaNonce[u.tokenId] + 1) revert BadNonce();
        _checkMetadata(u.name, u.symbol, u.imageURI);
        bytes32 structHash = keccak256(
            abi.encode(
                UPDATE_TYPEHASH, u.tokenId, keccak256(bytes(u.name)), keccak256(bytes(u.symbol)), keccak256(bytes(u.imageURI)), u.dailyCap, u.nonce
            )
        );
        _verify(_hashTypedData(structHash), sigs);
        metaNonce[u.tokenId] = u.nonce;
        caps[token].perDay = u.dailyCap;
        BridgeToken(token).setMetadata(u.name, u.symbol, u.imageURI);
        emit Updated(u.tokenId, token, u.name, u.symbol, u.imageURI, u.dailyCap, u.nonce);
    }

    // ------------------------------------------------------------ minting

    /// @notice Mints for a lock on the XRP Ledger that k operators attested. One lock, one mint.
    ///         Reverts `IsPaused` while mints are paused.
    function mint(Mint calldata m, bytes[] calldata sigs) external {
        if (paused) revert IsPaused();
        address token = tokens[m.tokenId];
        if (token == address(0)) revert UnknownToken();
        if (minted[m.srcTx]) revert AlreadyMinted();
        bytes32 structHash = keccak256(abi.encode(MINT_TYPEHASH, m.tokenId, m.to, m.amount, m.srcTx));
        _verify(_hashTypedData(structHash), sigs);
        minted[m.srcTx] = true;
        _spendCap(token, m.amount);
        BridgeToken(token).mint(m.to, m.amount);
        emit Minted(m.tokenId, m.to, m.amount, m.srcTx);
    }

    function _spendCap(address token, uint256 amount) internal {
        Cap storage c = caps[token];
        uint256 today = block.timestamp / 1 days;
        if (c.day != today) {
            c.day = today;
            c.used = 0;
        }
        uint256 used = c.used;
        if (c.perDay == UNCAPPED) {
            // No limit, but still counted so that a later, lower cap sees today's total. Saturating, so counting can never block a mint.
            c.used = amount > type(uint256).max - used ? type(uint256).max : used + amount;
            return;
        }
        // `used` can sit above `perDay` after a lowered cap, so test it before subtracting. A cap of 0 refuses every non-zero amount.
        if (used > c.perDay || amount > c.perDay - used) revert CapExceeded();
        c.used = used + amount;
    }

    // ------------------------------------------------------------ pause

    /// @notice Any current signer stops mints at once, with no signatures. Only `resume`, which takes k, restarts them.
    function pause() external {
        if (!isSigner[msg.sender]) revert NotSigner();
        if (paused) revert AlreadyPaused();
        paused = true;
        emit Paused(msg.sender);
    }

    /// @notice k signers restart mints. The signed message carries the current `resumeNonce`, so it works once.
    ///         It names no particular pause and has no deadline: signatures made for the current nonce resume
    ///         whichever pause is in force when they arrive, so they should be signed when they are about to be sent.
    function resume(uint256 nonce, bytes[] calldata sigs) external {
        if (!paused) revert NotPaused();
        if (nonce != resumeNonce) revert BadNonce();
        bytes32 structHash = keccak256(abi.encode(RESUME_TYPEHASH, nonce));
        _verify(_hashTypedData(structHash), sigs);
        resumeNonce = nonce + 1;
        paused = false;
        emit Resumed(nonce);
    }

    // ------------------------------------------------------------ fees

    /// @notice k signers change the exit fee, within `MAX_BURN_FEE`. The change carries the current `feeNonce`, so it works once.
    function setBurnFee(Fee calldata f, bytes[] calldata sigs) external {
        if (f.nonce != feeNonce) revert BadNonce();
        if (f.burnFee > MAX_BURN_FEE) revert BadFee();
        bytes32 structHash = keccak256(abi.encode(SET_BURN_FEE_TYPEHASH, f.burnFee, f.nonce));
        _verify(_hashTypedData(structHash), sigs);
        feeNonce = f.nonce + 1;
        uint256 old = burnFee;
        burnFee = f.burnFee;
        emit BurnFeeSet(old, f.burnFee);
    }

    /// @notice k signers pay out fee revenue: `amounts[i]` of this contract's XRP to `to[i]`, all or nothing.
    ///         The nonce moves before any XRP does, so a recipient that calls back in with the same signatures
    ///         meets `BadNonce`. Payments use `call`, so a recipient that is a contract gets full gas.
    function sweep(Sweep calldata s, bytes[] calldata sigs) external {
        uint256 n = s.to.length;
        if (n == 0 || n > MAX_SWEEP_ENTRIES || s.amounts.length != n) revert BadSweep();
        for (uint256 i = 0; i < n; i++) {
            if (s.to[i] == address(0)) revert BadSweep();
        }
        if (s.nonce != sweepNonce) revert BadNonce();
        bytes32 structHash =
            keccak256(abi.encode(SWEEP_TYPEHASH, keccak256(abi.encodePacked(s.to)), keccak256(abi.encodePacked(s.amounts)), s.nonce));
        _verify(_hashTypedData(structHash), sigs);
        sweepNonce = s.nonce + 1;
        emit Swept(s.to, s.amounts, s.nonce);
        for (uint256 i = 0; i < n; i++) {
            (bool ok,) = s.to[i].call{value: s.amounts[i]}("");
            if (!ok) revert SweepFailed();
        }
    }

    // ------------------------------------------------------------ rotation

    /// @notice k current signers propose a new signer set. It can execute after the delay.
    ///         Signs the current proposalSeq, so resubmitting the same calldata cannot reset the delay.
    function proposeRotation(Rotation calldata r, bytes[] calldata sigs) external {
        if (r.nonce != rotationNonce) revert BadNonce();
        if (r.seq != proposalSeq) revert BadSeq();
        bytes32 structHash = keccak256(abi.encode(ROTATE_TYPEHASH, keccak256(abi.encodePacked(r.signers)), r.threshold, r.nonce, r.seq));
        _verify(_hashTypedData(structHash), sigs);
        _checkSignerSet(r.signers, r.threshold);
        proposalSeq++;
        pendingRotation = structHash;
        pendingRotationAt = block.timestamp + rotationDelay;
        _pendingSigners = r.signers;
        _pendingThreshold = r.threshold;
        emit RotationProposed(structHash, r.signers, r.threshold, pendingRotationAt);
    }

    /// @notice Anyone may execute a proposed rotation once its delay has passed.
    function executeRotation() external {
        if (pendingRotation == bytes32(0)) revert NoPendingRotation();
        if (block.timestamp < pendingRotationAt) revert RotationNotReady();
        _setSigners(_pendingSigners, _pendingThreshold);
        rotationNonce++;
        pendingRotation = bytes32(0);
        pendingRotationAt = 0;
        delete _pendingSigners;
        _pendingThreshold = 0;
        emit RotationExecuted(_signers, threshold);
    }

    /// @notice k current signers cancel the pending rotation. The signed message names that rotation
    ///         and the current proposalSeq, so it cancels exactly one proposal, once.
    function cancelRotation(bytes[] calldata sigs) external {
        if (pendingRotation == bytes32(0)) revert NoPendingRotation();
        bytes32 rotation = pendingRotation;
        bytes32 structHash = keccak256(abi.encode(CANCEL_TYPEHASH, rotation, proposalSeq));
        _verify(_hashTypedData(structHash), sigs);
        proposalSeq++;
        pendingRotation = bytes32(0);
        pendingRotationAt = 0;
        delete _pendingSigners;
        _pendingThreshold = 0;
        emit RotationCancelled(rotation);
    }

    // ------------------------------------------------------------ internals

    /// @dev Name 1 to 64 bytes, symbol 1 to 32 bytes, logo URI at most 256 bytes (empty allowed).
    function _checkMetadata(string calldata name_, string calldata symbol_, string calldata imageURI_) internal pure {
        uint256 n = bytes(name_).length;
        uint256 s = bytes(symbol_).length;
        if (n == 0 || n > MAX_NAME_BYTES || s == 0 || s > MAX_SYMBOL_BYTES || bytes(imageURI_).length > MAX_IMAGE_URI_BYTES) {
            revert BadMetadata();
        }
    }

    function _checkSignerSet(address[] memory set, uint8 t) internal pure {
        if (set.length == 0 || set.length > 32 || t == 0 || t > set.length) revert BadSignerSet();
        for (uint256 i = 0; i < set.length; i++) {
            if (set[i] == address(0)) revert BadSignerSet();
            for (uint256 j = i + 1; j < set.length; j++) {
                if (set[i] == set[j]) revert BadSignerSet();
            }
        }
    }

    function _setSigners(address[] memory set, uint8 t) internal {
        _checkSignerSet(set, t);
        for (uint256 i = 0; i < _signers.length; i++) isSigner[_signers[i]] = false;
        _signers = set;
        for (uint256 i = 0; i < set.length; i++) isSigner[set[i]] = true;
        threshold = t;
    }

    /// @dev k valid signatures from distinct signers, given in ascending signer address order.
    function _verify(bytes32 digest, bytes[] calldata sigs) internal view {
        if (sigs.length < threshold) revert NotEnoughSignatures();
        address last = address(0);
        for (uint256 i = 0; i < sigs.length; i++) {
            address s = ECDSA.recover(digest, sigs[i]);
            if (!isSigner[s]) revert BadSignature();
            if (s <= last) revert SignersNotSorted();
            last = s;
        }
    }

    /// @notice The EIP-712 domain separator: the name and version above, the chain, and this contract's address.
    ///         Built from `block.chainid` on every call, so a signature made for another chain never verifies.
    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(DOMAIN_NAME)), keccak256(bytes(DOMAIN_VERSION)), block.chainid, address(this)));
    }

    /// @notice ERC-5267: the domain's fields, for wallets and libraries that read them from the contract.
    function eip712Domain()
        external
        view
        override
        returns (bytes1 fields, string memory name, string memory version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] memory extensions)
    {
        return (hex"0f", DOMAIN_NAME, DOMAIN_VERSION, block.chainid, address(this), bytes32(0), new uint256[](0));
    }

    function _hashTypedData(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }
}
