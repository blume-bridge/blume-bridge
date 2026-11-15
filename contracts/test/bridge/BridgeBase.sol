// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ThresholdMinter} from "../../src/bridge/ThresholdMinter.sol";
import {BridgeToken} from "../../src/bridge/BridgeToken.sol";

/// What every bridge test starts from: three signers (k = 2) behind one minter with a 0.25 XRP exit fee, and each
/// signed message built the way the cluster builds it. The digest helpers hash with the minter's own typehash
/// constants; TypedData.t.sol checks those constants against the spec strings and against digests built from JSON.
abstract contract BridgeBase is Test {
    uint256 constant FEE = 0.25 ether;
    uint256 constant CAP = 1000e18;
    bytes32 constant TOKEN = keccak256("PETAL");
    string constant IMAGE = "ipfs://bafkreipetal";
    string constant IMAGE_2 = "ar://petal-two";
    string constant R_ADDRESS = "r4eN64rUAJPWibBs2gvUmdfEoZMYiFqc9M";
    /// A real X-address (47 characters) and its test-network twin.
    string constant X_ADDRESS = "X7AcgcsBL6XDcUb289X4mJ8djcdyKaB5hJDWMArnXr61cqZ";
    string constant T_ADDRESS = "T719a5UwUCnEs54UsxG9CJYYDhwmFCqkr7wxCcNcfZ6p5GZ";

    ThresholdMinter minter;
    uint256[] keys;
    address[] signers;

    function setUp() public virtual {
        // three signers, threshold two; keys chosen so addresses sort deterministically after sorting below
        keys = [uint256(0xA11CE), uint256(0xB0B), uint256(0xCA201)];
        for (uint256 i = 0; i < keys.length; i++) signers.push(vm.addr(keys[i]));
        _sortByAddress();
        minter = new ThresholdMinter(signers, 2, 1 days, FEE);
    }

    function _sortByAddress() internal {
        for (uint256 i = 0; i < signers.length; i++) {
            for (uint256 j = i + 1; j < signers.length; j++) {
                if (signers[j] < signers[i]) {
                    (signers[i], signers[j]) = (signers[j], signers[i]);
                    (keys[i], keys[j]) = (keys[j], keys[i]);
                }
            }
        }
    }

    /// `n` keys counting up from `seed`, with their addresses, sorted ascending by address as signatures must be.
    function _sortedSet(uint256 seed, uint256 n) internal pure returns (uint256[] memory ks, address[] memory addrs) {
        ks = new uint256[](n);
        addrs = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            ks[i] = seed + i;
            addrs[i] = vm.addr(ks[i]);
        }
        for (uint256 i = 0; i < n; i++) {
            for (uint256 j = i + 1; j < n; j++) {
                if (addrs[j] < addrs[i]) {
                    (addrs[i], addrs[j]) = (addrs[j], addrs[i]);
                    (ks[i], ks[j]) = (ks[j], ks[i]);
                }
            }
        }
    }

    // ------------------------------------------------------------ signing

    function _sign(bytes32 digest, uint256[] memory which) internal view returns (bytes[] memory sigs) {
        sigs = new bytes[](which.length);
        for (uint256 i = 0; i < which.length; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(keys[which[i]], digest);
            sigs[i] = abi.encodePacked(r, s, v);
        }
    }

    /// Signatures from the first `count` of `ks`, in the order given (callers pass keys sorted by address).
    function _signWith(uint256[] memory ks, uint256 count, bytes32 digest) internal pure returns (bytes[] memory sigs) {
        sigs = new bytes[](count);
        for (uint256 i = 0; i < count; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(ks[i], digest);
            sigs[i] = abi.encodePacked(r, s, v);
        }
    }

    function _two() internal pure returns (uint256[] memory w) {
        w = new uint256[](2);
        w[0] = 0;
        w[1] = 1;
    }

    function _three() internal pure returns (uint256[] memory w) {
        w = new uint256[](3);
        w[0] = 0;
        w[1] = 1;
        w[2] = 2;
    }

    /// One valid signature from `keys[0]` and one from a key that is not a signer: the second is what fails.
    function _withOutsider(bytes32 digest) internal view returns (bytes[] memory sigs) {
        sigs = new bytes[](2);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(keys[0], digest);
        sigs[0] = abi.encodePacked(r, s, v);
        (v, r, s) = vm.sign(uint256(0xDEAD), digest);
        sigs[1] = abi.encodePacked(r, s, v);
    }

    function _one(bytes32 digest) internal view returns (bytes[] memory sigs) {
        uint256[] memory one = new uint256[](1);
        one[0] = 0;
        sigs = _sign(digest, one);
    }

    // ------------------------------------------------------------ struct hashes and digests

    // The struct hashes use the minter's typehash constants (the same ones on every minter); the digests add a domain.

    function _listHash(ThresholdMinter.Listing memory l) internal view returns (bytes32) {
        return keccak256(
            abi.encode(minter.LIST_TYPEHASH(), l.tokenId, keccak256(bytes(l.name)), keccak256(bytes(l.symbol)), keccak256(bytes(l.imageURI)), l.dailyCap)
        );
    }

    function _updateHash(ThresholdMinter.Update memory u) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                minter.UPDATE_TYPEHASH(), u.tokenId, keccak256(bytes(u.name)), keccak256(bytes(u.symbol)), keccak256(bytes(u.imageURI)), u.dailyCap, u.nonce
            )
        );
    }

    function _mintHash(ThresholdMinter.Mint memory m) internal view returns (bytes32) {
        return keccak256(abi.encode(minter.MINT_TYPEHASH(), m.tokenId, m.to, m.amount, m.srcTx));
    }

    function _rotateHash(ThresholdMinter.Rotation memory r) internal view returns (bytes32) {
        return keccak256(abi.encode(minter.ROTATE_TYPEHASH(), keccak256(abi.encodePacked(r.signers)), r.threshold, r.nonce, r.seq));
    }

    function _cancelHash(bytes32 rotation, uint256 seq) internal view returns (bytes32) {
        return keccak256(abi.encode(minter.CANCEL_TYPEHASH(), rotation, seq));
    }

    function _feeHash(ThresholdMinter.Fee memory f) internal view returns (bytes32) {
        return keccak256(abi.encode(minter.SET_BURN_FEE_TYPEHASH(), f.burnFee, f.nonce));
    }

    function _sweepHash(ThresholdMinter.Sweep memory s) internal view returns (bytes32) {
        return keccak256(abi.encode(minter.SWEEP_TYPEHASH(), keccak256(abi.encodePacked(s.to)), keccak256(abi.encodePacked(s.amounts)), s.nonce));
    }

    function _resumeHash(uint256 nonce) internal view returns (bytes32) {
        return keccak256(abi.encode(minter.RESUME_TYPEHASH(), nonce));
    }

    /// EIP-712 digest of a struct hash under `m`'s domain (its name, version, chain and address).
    function _digestFor(ThresholdMinter m, bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", m.domainSeparator(), structHash));
    }

    function _digest(bytes32 structHash) internal view returns (bytes32) {
        return _digestFor(minter, structHash);
    }

    function _listDigest(ThresholdMinter.Listing memory l) internal view returns (bytes32) {
        return _digest(_listHash(l));
    }

    function _updateDigest(ThresholdMinter.Update memory u) internal view returns (bytes32) {
        return _digest(_updateHash(u));
    }

    function _mintDigest(ThresholdMinter.Mint memory m) internal view returns (bytes32) {
        return _digest(_mintHash(m));
    }

    function _rotateDigest(ThresholdMinter.Rotation memory r) internal view returns (bytes32) {
        return _digest(_rotateHash(r));
    }

    function _cancelDigest(bytes32 rotation, uint256 seq) internal view returns (bytes32) {
        return _digest(_cancelHash(rotation, seq));
    }

    function _feeDigest(ThresholdMinter.Fee memory f) internal view returns (bytes32) {
        return _digest(_feeHash(f));
    }

    function _sweepDigest(ThresholdMinter.Sweep memory s) internal view returns (bytes32) {
        return _digest(_sweepHash(s));
    }

    function _resumeDigest(uint256 nonce) internal view returns (bytes32) {
        return _digest(_resumeHash(nonce));
    }

    // ------------------------------------------------------------ listing and minting

    function _listing(string memory name_, string memory symbol_, string memory imageURI_) internal pure returns (ThresholdMinter.Listing memory) {
        return ThresholdMinter.Listing({tokenId: TOKEN, name: name_, symbol: symbol_, imageURI: imageURI_, dailyCap: CAP});
    }

    function _listing(uint256 cap) internal pure returns (ThresholdMinter.Listing memory) {
        return ThresholdMinter.Listing({tokenId: TOKEN, name: "Petal", symbol: "PETAL", imageURI: IMAGE, dailyCap: cap});
    }

    function _list() internal returns (address token) {
        ThresholdMinter.Listing memory l = _listing("Petal", "PETAL", IMAGE);
        token = minter.listToken(l, _sign(_listDigest(l), _two()));
    }

    function _listCapped(uint256 cap) internal returns (address token) {
        ThresholdMinter.Listing memory l = _listing(cap);
        token = minter.listToken(l, _sign(_listDigest(l), _two()));
    }

    function _update(string memory name_, string memory symbol_, string memory imageURI_, uint256 dailyCap, uint256 nonce)
        internal
        pure
        returns (ThresholdMinter.Update memory)
    {
        return ThresholdMinter.Update({tokenId: TOKEN, name: name_, symbol: symbol_, imageURI: imageURI_, dailyCap: dailyCap, nonce: nonce});
    }

    /// Replaces PETAL's daily cap through the next signed update, leaving its name, symbol and logo as listed.
    function _setCap(uint256 cap) internal {
        ThresholdMinter.Update memory u = _update("Petal", "PETAL", IMAGE, cap, minter.metaNonce(TOKEN) + 1);
        minter.updateToken(u, _sign(_updateDigest(u), _two()));
    }

    /// A mint of `amount` PETAL to address(1) for the lock `srcTx`, signed by two signers.
    function _signedMint(uint256 amount, bytes32 srcTx) internal view returns (ThresholdMinter.Mint memory m, bytes[] memory sigs) {
        m = ThresholdMinter.Mint({tokenId: TOKEN, to: address(1), amount: amount, srcTx: srcTx});
        sigs = _sign(_mintDigest(m), _two());
    }

    function _mintTo(address to, uint256 amount, bytes32 srcTx) internal {
        ThresholdMinter.Mint memory m = ThresholdMinter.Mint({tokenId: TOKEN, to: to, amount: amount, srcTx: srcTx});
        minter.mint(m, _sign(_mintDigest(m), _two()));
    }

    function _ofLength(uint256 n) internal pure returns (string memory) {
        bytes memory b = new bytes(n);
        for (uint256 i = 0; i < n; i++) b[i] = "a";
        return string(b);
    }

    // ------------------------------------------------------------ rotation

    function _nextSet() internal pure returns (address[] memory next) {
        next = new address[](2);
        next[0] = address(0x1111);
        next[1] = address(0x2222);
    }

    function _rotation(address[] memory next, uint256 nonce, uint256 seq) internal pure returns (ThresholdMinter.Rotation memory) {
        return ThresholdMinter.Rotation({signers: next, threshold: 2, nonce: nonce, seq: seq});
    }

    // ------------------------------------------------------------ fee, sweep, pause

    function _setFee(uint256 fee) internal {
        ThresholdMinter.Fee memory f = ThresholdMinter.Fee({burnFee: fee, nonce: minter.feeNonce()});
        minter.setBurnFee(f, _sign(_feeDigest(f), _two()));
    }

    /// A sweep paying `amounts[i]` to `to[i]` under the minter's current sweep nonce, signed by two signers.
    function _signedSweep(address[] memory to, uint256[] memory amounts) internal view returns (ThresholdMinter.Sweep memory s, bytes[] memory sigs) {
        s = ThresholdMinter.Sweep({to: to, amounts: amounts, nonce: minter.sweepNonce()});
        sigs = _sign(_sweepDigest(s), _two());
    }

    function _pay(address to, uint256 amount) internal pure returns (address[] memory tos, uint256[] memory amounts) {
        tos = new address[](1);
        amounts = new uint256[](1);
        tos[0] = to;
        amounts[0] = amount;
    }

    function _resume() internal {
        uint256 n = minter.resumeNonce();
        minter.resume(n, _sign(_resumeDigest(n), _two()));
    }

    function _pauseBy(uint256 signerIndex) internal {
        vm.prank(signers[signerIndex]);
        minter.pause();
    }
}
