// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev The one thing a token asks its minter for: the exit fee a burn must carry.
interface IBurnFee {
    function burnFee() external view returns (uint256);
}

/// @title BridgeToken
/// @notice One ERC-20 per token the Blume Bridge lists. Minted only by the
///         ThresholdMinter once k operators attest a lock on the XRP Ledger;
///         burned by holders to release on the XRP Ledger. The burn carries
///         the XRP Ledger address the cluster releases to and the exit fee in
///         native XRP, which moves on to the minter. The name, symbol and logo
///         change only through the minter, which acts only on an update k
///         operators signed. Burning is never paused or blocked by the minter.
contract BridgeToken is ERC20 {
    address public immutable minter;
    uint256 public burnCount;
    /// @notice The token's logo as a URI (ipfs://, ar://, https://). May be empty.
    string public imageURI;

    // OpenZeppelin keeps its own name and symbol private and set once, so the
    // current values live here and name() and symbol() read them.
    string private _tokenName;
    string private _tokenSymbol;

    event Burn(address indexed from, uint256 amount, string rAddress, uint256 indexed nonce);
    event MetadataUpdated(string name, string symbol, string imageURI);

    error NotMinter();
    error BadAddress();
    error BadAmount();
    /// @dev `msg.value` is not exactly the minter's `burnFee()`.
    error BadFeePayment();
    /// @dev The minter did not take the fee, so the whole burn is undone.
    error FeeTransferFailed();

    /// @dev OpenZeppelin's copies stay empty: nothing reads them once name() and symbol() are overridden.
    constructor(string memory name_, string memory symbol_, string memory imageURI_, address minter_) ERC20("", "") {
        minter = minter_;
        _tokenName = name_;
        _tokenSymbol = symbol_;
        imageURI = imageURI_;
    }

    /// @notice The token's current name.
    function name() public view override returns (string memory) {
        return _tokenName;
    }

    /// @notice The token's current symbol.
    function symbol() public view override returns (string memory) {
        return _tokenSymbol;
    }

    /// @notice Mints `amount` to `to`. Minter only: it calls this for a lock k operators attested.
    function mint(address to, uint256 amount) external {
        if (msg.sender != minter) revert NotMinter();
        _mint(to, amount);
    }

    /// @notice Replaces the name, symbol and logo. Minter only: it calls this for an update k operators signed.
    function setMetadata(string calldata name_, string calldata symbol_, string calldata imageURI_) external {
        if (msg.sender != minter) revert NotMinter();
        _tokenName = name_;
        _tokenSymbol = symbol_;
        imageURI = imageURI_;
        emit MetadataUpdated(name_, symbol_, imageURI_);
    }

    /// @notice Burns `amount` from the caller and asks the cluster to release it to `rAddress` on the XRP Ledger:
    ///         a classic address (25 to 35 characters, starting "r") or an X-address (exactly 47 characters,
    ///         starting "X" or "T"). The contract does not decode it; the cluster does.
    ///         `msg.value` must equal the minter's `burnFee()` exactly (with a fee of zero, it must be zero);
    ///         the minter keeps it. A fee that moved between signing and inclusion fails the burn rather than
    ///         over- or under-charging it.
    function burn(uint256 amount, string calldata rAddress) external payable returns (uint256 nonce) {
        // A zero burn releases nothing yet would still queue a release the ledger rejects, holding up every release behind it.
        if (amount == 0) revert BadAmount();
        if (!_isXrplDestination(bytes(rAddress))) revert BadAddress();
        if (msg.value != IBurnFee(minter).burnFee()) revert BadFeePayment();
        _burn(msg.sender, amount);
        nonce = ++burnCount;
        emit Burn(msg.sender, amount, rAddress, nonce);
        // Last, after every state change, and with `call` rather than `transfer`: the minter's receive() reads
        // storage, which the 2300 gas of `transfer` cannot pay for. A failed forward reverts the whole burn.
        if (msg.value != 0) {
            (bool ok,) = minter.call{value: msg.value}("");
            if (!ok) revert FeeTransferFailed();
        }
    }

    /// @dev Classic: 25 to 35 characters starting "r". X-address: exactly 47 characters starting "X" (main network) or "T" (test network).
    function _isXrplDestination(bytes calldata r) private pure returns (bool) {
        uint256 n = r.length;
        if (n >= 25 && n <= 35) return r[0] == "r";
        if (n == 47) return r[0] == "X" || r[0] == "T";
        return false;
    }
}
