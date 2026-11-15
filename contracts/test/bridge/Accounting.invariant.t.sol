// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BridgeBase} from "./BridgeBase.sol";
import {ThresholdMinter} from "../../src/bridge/ThresholdMinter.sol";
import {BridgeToken} from "../../src/bridge/BridgeToken.sol";

/// Random sequences of mints, burns (with the right fee and with wrong ones), fee changes, sweeps, pauses, resumes and
/// days passing. Whatever the order: the minter holds exactly the fees paid in minus the sweeps paid out, the token
/// holds nothing, supply is what was minted minus what was burned, and every nonce counts its own operation.
///
/// The handlers never swallow a revert. An operation that must go through (an exact-fee burn, a mint while not paused, a
/// sweep within the balance) is called plainly, so a regression that made it fail fails the run; one that must be
/// refused (a wrong fee, a mint while paused) is called under `expectRevert` with its error. The scripted test at the
/// end runs each path once, so the counters the invariants rest on are known to move.
///
/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 120
contract AccountingInvariantTest is BridgeBase {
    BridgeToken token;
    address[] users;
    address[] payees;

    uint256 mintedTotal;
    uint256 burnedTotal;
    uint256 feesIn;
    uint256 sweptTotal;
    uint256 burnsDone;
    uint256 sweepsDone;
    uint256 feeChanges;
    uint256 resumesDone;
    uint256 locks;
    bool expectPaused;

    function setUp() public override {
        super.setUp();
        token = BridgeToken(_listCapped(type(uint256).max));
        for (uint256 i = 0; i < 4; i++) {
            address user = makeAddr(string.concat("user", vm.toString(i)));
            vm.deal(user, 1_000 ether);
            users.push(user);
            payees.push(makeAddr(string.concat("payee", vm.toString(i))));
        }
        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = this.handlerMint.selector;
        selectors[1] = this.handlerBurn.selector;
        selectors[2] = this.handlerSetFee.selector;
        selectors[3] = this.handlerSweep.selector;
        selectors[4] = this.handlerPause.selector;
        selectors[5] = this.handlerResume.selector;
        selectors[6] = this.handlerWarp.selector;
        targetSelector(FuzzSelector({addr: address(this), selectors: selectors}));
        // Only the operations above move state; random calls straight at the contracts would only revert.
        excludeContract(address(minter));
        excludeContract(address(minter.factory()));
        excludeContract(address(token));
    }

    // ------------------------------------------------------------ the operations the fuzzer chains

    function handlerMint(uint256 who, uint256 amount) external {
        address to = users[who % users.length];
        amount = bound(amount, 1, 1_000e18);
        ThresholdMinter.Mint memory m = ThresholdMinter.Mint({tokenId: TOKEN, to: to, amount: amount, srcTx: keccak256(abi.encode("lock", locks++))});
        bytes[] memory sigs = _sign(_mintDigest(m), _two());
        if (expectPaused) {
            vm.expectRevert(ThresholdMinter.IsPaused.selector);
            minter.mint(m, sigs);
        } else {
            // The token is uncapped and the lock is new, so this must go through.
            minter.mint(m, sigs);
            mintedTotal += amount;
        }
    }

    function handlerBurn(uint256 who, uint256 amount, uint256 sent, bool exact) external {
        address user = users[who % users.length];
        uint256 held = token.balanceOf(user);
        if (held == 0) return;
        amount = bound(amount, 1, held);
        uint256 fee = minter.burnFee();
        sent = exact ? fee : bound(sent, 0, 2 ether);
        if (sent == fee) {
            vm.prank(user);
            token.burn{value: sent}(amount, R_ADDRESS);
            feesIn += sent;
            burnedTotal += amount;
            burnsDone++;
        } else {
            vm.prank(user);
            vm.expectRevert(BridgeToken.BadFeePayment.selector);
            token.burn{value: sent}(amount, R_ADDRESS);
        }
    }

    function handlerSetFee(uint256 fee) external {
        _setFee(bound(fee, 0, 1 ether));
        feeChanges++;
    }

    function handlerSweep(uint256 who, uint256 amount) external {
        amount = bound(amount, 0, address(minter).balance);
        (address[] memory to, uint256[] memory amounts) = _pay(payees[who % payees.length], amount);
        (ThresholdMinter.Sweep memory s, bytes[] memory sigs) = _signedSweep(to, amounts);
        // The payees are plain accounts and the amount is within the balance, so this must go through.
        minter.sweep(s, sigs);
        sweptTotal += amount;
        sweepsDone++;
    }

    function handlerPause(uint256 who) external {
        if (expectPaused) return;
        _pauseBy(who % signers.length);
        expectPaused = true;
    }

    function handlerResume() external {
        if (!expectPaused) return;
        _resume();
        expectPaused = false;
        resumesDone++;
    }

    function handlerWarp(uint256 secondsPassed) external {
        vm.warp(block.timestamp + bound(secondsPassed, 0, 3 days));
    }

    // ------------------------------------------------------------ what must always hold

    function invariant_theMinterHoldsTheFeesPaidInMinusTheSweepsPaidOut() public view {
        assertEq(address(minter).balance, feesIn - sweptTotal);
    }

    function invariant_thePayeesHoldExactlyWhatWasSwept() public view {
        uint256 held;
        for (uint256 i = 0; i < payees.length; i++) held += payees[i].balance;
        assertEq(held, sweptTotal);
    }

    function invariant_theTokenHoldsNoXrp() public view {
        assertEq(address(token).balance, 0);
    }

    function invariant_supplyIsMintedMinusBurned() public view {
        assertEq(token.totalSupply(), mintedTotal - burnedTotal);
    }

    function invariant_everyNonceCountsItsOwnOperation() public view {
        assertEq(token.burnCount(), burnsDone);
        assertEq(minter.sweepNonce(), sweepsDone);
        assertEq(minter.feeNonce(), feeChanges);
        assertEq(minter.resumeNonce(), resumesDone);
    }

    function invariant_thePauseIsWhatTheOperationsLeftIt() public view {
        assertEq(minter.paused(), expectPaused);
    }

    function invariant_theFeeNeverPassesItsCeiling() public view {
        assertLe(minter.burnFee(), minter.MAX_BURN_FEE());
    }

    // ------------------------------------------------------------ the handlers do reach the paths

    /// One pass through every path, so the counters above are known to move: fees arrive, a wrong fee is refused,
    /// sweeps pay out, a pause holds a mint back and a resume lets the next one through.
    function test_theHandlersReachEveryPath() public {
        this.handlerMint(0, 500e18);
        assertEq(mintedTotal, 500e18);

        this.handlerBurn(0, 100e18, 0, true);
        assertEq(burnsDone, 1);
        assertEq(feesIn, FEE);
        assertEq(address(minter).balance, FEE);

        this.handlerBurn(0, 100e18, 1, false); // sent 1 wei against a fee of 0.25 XRP: refused, nothing moves
        assertEq(burnsDone, 1);
        assertEq(address(minter).balance, FEE);

        this.handlerSetFee(0.1 ether);
        assertEq(feeChanges, 1);
        this.handlerBurn(0, 50e18, 0, true);
        assertEq(feesIn, FEE + 0.1 ether);

        this.handlerSweep(1, 0.2 ether);
        assertEq(sweepsDone, 1);
        assertEq(sweptTotal, 0.2 ether);
        assertEq(payees[1].balance, 0.2 ether);

        this.handlerPause(2);
        assertTrue(minter.paused());
        this.handlerMint(1, 10e18); // refused under the pause
        assertEq(mintedTotal, 500e18);
        this.handlerResume();
        assertFalse(minter.paused());
        assertEq(resumesDone, 1);
        this.handlerMint(1, 10e18);
        assertEq(mintedTotal, 510e18);

        // The same ledger the invariants check.
        assertEq(address(minter).balance, feesIn - sweptTotal);
        assertEq(token.totalSupply(), mintedTotal - burnedTotal);
    }
}
