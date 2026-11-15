// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BridgeToken} from "./BridgeToken.sol";

/// @title TokenFactory
/// @notice Deploys one BridgeToken per listing. Only the minter may call it,
///         so a listing exists on the EVM side only after k operators signed.
contract TokenFactory {
    address public immutable minter;

    event Deployed(address indexed token, string name, string symbol, string imageURI);

    error NotMinter();

    constructor(address minter_) {
        minter = minter_;
    }

    /// @notice Deploys the ERC-20 for a listing. The minter is its only minter and the only one who can change its metadata.
    function deploy(string calldata name, string calldata symbol, string calldata imageURI) external returns (address token) {
        if (msg.sender != minter) revert NotMinter();
        token = address(new BridgeToken(name, symbol, imageURI, minter));
        emit Deployed(token, name, symbol, imageURI);
    }
}
