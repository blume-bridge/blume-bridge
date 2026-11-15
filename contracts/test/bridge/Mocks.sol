// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BridgeToken} from "../../src/bridge/BridgeToken.sol";

/// Takes a payment, then calls straight back into `target` with the calldata it was armed with, and keeps what
/// came back. Its receive() writes storage, so it also proves a payment forwards more than the 2300 gas of `transfer`.
contract ReenteringRecipient {
    address public immutable target;
    bytes public payload;
    uint256 public received;
    bool public reentered;
    bool public replayOk;
    bytes4 public replayError;

    constructor(address target_) {
        target = target_;
    }

    function arm(bytes calldata payload_) external {
        payload = payload_;
    }

    receive() external payable {
        received += msg.value;
        if (payload.length == 0 || reentered) return;
        reentered = true;
        (bool ok, bytes memory ret) = target.call(payload);
        replayOk = ok;
        if (!ok && ret.length >= 4) replayError = bytes4(ret);
    }
}

/// Refuses every payment.
contract RefusingRecipient {
    receive() external payable {
        revert("no");
    }
}

/// Stands in for a minter when a token is built by hand: quotes a fee, mints on request, and can refuse the fee
/// or burn again from inside the transfer that carries it.
contract StubMinter {
    uint256 public burnFee;
    BridgeToken public token;
    bool public refuse;
    bool public burnAgain;
    uint256 public innerNonce;
    uint256 public timesPaid;

    constructor(uint256 fee) {
        burnFee = fee;
    }

    function setToken(BridgeToken t) external {
        token = t;
    }

    function setRefuse(bool b) external {
        refuse = b;
    }

    function setBurnAgain(bool b) external {
        burnAgain = b;
    }

    function mintTo(address to, uint256 amount) external {
        token.mint(to, amount);
    }

    receive() external payable {
        if (refuse) revert("fee refused");
        timesPaid++;
        if (burnAgain) {
            burnAgain = false;
            innerNonce = token.burn{value: burnFee}(1, "r4eN64rUAJPWibBs2gvUmdfEoZMYiFqc9M");
        }
    }
}
