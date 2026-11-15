// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BridgeBase} from "./BridgeBase.sol";
import {ReenteringRecipient, RefusingRecipient} from "./Mocks.sol";
import {ThresholdMinter} from "../../src/bridge/ThresholdMinter.sol";

/// Paying fee revenue out of the minter: k signatures over the recipients and amounts, the nonce spent before any XRP
/// moves, and all of it or none of it.
contract SweepTest is BridgeBase {
    address op1;
    address op2;
    address treasury;

    function setUp() public override {
        super.setUp();
        op1 = makeAddr("operator1");
        op2 = makeAddr("operator2");
        treasury = makeAddr("treasury");
        // Stands in for fees that burns have collected (the whole path is in ExitFee.t.sol).
        vm.deal(address(minter), 10 ether);
    }

    function _trio(uint256 a, uint256 b, uint256 c) internal view returns (address[] memory to, uint256[] memory amounts) {
        to = new address[](3);
        amounts = new uint256[](3);
        to[0] = op1;
        to[1] = op2;
        to[2] = treasury;
        amounts[0] = a;
        amounts[1] = b;
        amounts[2] = c;
    }

    function _same(address who, uint256 amount, uint256 n) internal pure returns (address[] memory to, uint256[] memory amounts) {
        to = new address[](n);
        amounts = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            to[i] = who;
            amounts[i] = amount;
        }
    }

    // ------------------------------------------------------------ paying out

    function test_sweepPaysEveryRecipient() public {
        (address[] memory to, uint256[] memory amounts) = _trio(1 ether, 2 ether, 3 ether);
        (ThresholdMinter.Sweep memory s, bytes[] memory sigs) = _signedSweep(to, amounts);
        vm.expectEmit(false, false, false, true, address(minter));
        emit ThresholdMinter.Swept(to, amounts, 0);
        minter.sweep(s, sigs);
        assertEq(op1.balance, 1 ether);
        assertEq(op2.balance, 2 ether);
        assertEq(treasury.balance, 3 ether);
        assertEq(address(minter).balance, 4 ether);
        assertEq(minter.sweepNonce(), 1);
    }

    function test_anyoneCanRelayASignedSweep() public {
        (address[] memory to, uint256[] memory amounts) = _trio(1 ether, 0, 0);
        (ThresholdMinter.Sweep memory s, bytes[] memory sigs) = _signedSweep(to, amounts);
        vm.prank(makeAddr("stranger"));
        minter.sweep(s, sigs);
        assertEq(op1.balance, 1 ether);
    }

    function test_sweepCanPayOutTheWholeBalance() public {
        (address[] memory to, uint256[] memory amounts) = _trio(4 ether, 3 ether, 3 ether);
        (ThresholdMinter.Sweep memory s, bytes[] memory sigs) = _signedSweep(to, amounts);
        minter.sweep(s, sigs);
        assertEq(address(minter).balance, 0);
    }

    function test_sweepPaysARecipientListedTwiceTwice() public {
        (address[] memory to, uint256[] memory amounts) = _same(op1, 1 ether, 3);
        (ThresholdMinter.Sweep memory s, bytes[] memory sigs) = _signedSweep(to, amounts);
        minter.sweep(s, sigs);
        assertEq(op1.balance, 3 ether);
    }

    function test_sweepPaysAContractThatNeedsMoreThanTheTransferStipend() public {
        // Its receive() writes storage, which costs far more than the 2300 gas that transfer and send forward.
        ReenteringRecipient wallet = new ReenteringRecipient(address(minter));
        (address[] memory to, uint256[] memory amounts) = _pay(address(wallet), 1 ether);
        (ThresholdMinter.Sweep memory s, bytes[] memory sigs) = _signedSweep(to, amounts);
        minter.sweep(s, sigs);
        assertEq(wallet.received(), 1 ether);
        assertEq(address(wallet).balance, 1 ether);
    }

    function test_sweepAcceptsOneToThirtyTwoEntries() public {
        assertEq(minter.MAX_SWEEP_ENTRIES(), 32);
        (address[] memory one, uint256[] memory oneAmounts) = _same(op1, 1, 1);
        (ThresholdMinter.Sweep memory s1, bytes[] memory sigs1) = _signedSweep(one, oneAmounts);
        minter.sweep(s1, sigs1);
        (address[] memory many, uint256[] memory manyAmounts) = _same(op2, 1, 32);
        (ThresholdMinter.Sweep memory s32, bytes[] memory sigs32) = _signedSweep(many, manyAmounts);
        minter.sweep(s32, sigs32);
        assertEq(op1.balance, 1);
        assertEq(op2.balance, 32);
        assertEq(minter.sweepNonce(), 2);
    }

    // ------------------------------------------------------------ the nonce

    function test_sweepCannotBeReplayed() public {
        (address[] memory to, uint256[] memory amounts) = _trio(1 ether, 0, 0);
        (ThresholdMinter.Sweep memory s, bytes[] memory sigs) = _signedSweep(to, amounts);
        minter.sweep(s, sigs);
        vm.expectRevert(ThresholdMinter.BadNonce.selector);
        minter.sweep(s, sigs);
        assertEq(op1.balance, 1 ether);
    }

    function test_sweepNoncesRunInOrder() public {
        (address[] memory to, uint256[] memory amounts) = _trio(1 ether, 0, 0);
        ThresholdMinter.Sweep memory first = ThresholdMinter.Sweep({to: to, amounts: amounts, nonce: 0});
        ThresholdMinter.Sweep memory second = ThresholdMinter.Sweep({to: to, amounts: amounts, nonce: 1});
        bytes[] memory sigsFirst = _sign(_sweepDigest(first), _two());
        bytes[] memory sigsSecond = _sign(_sweepDigest(second), _two());
        vm.expectRevert(ThresholdMinter.BadNonce.selector);
        minter.sweep(second, sigsSecond);
        minter.sweep(first, sigsFirst);
        minter.sweep(second, sigsSecond);
        assertEq(op1.balance, 2 ether);
        vm.expectRevert(ThresholdMinter.BadNonce.selector);
        minter.sweep(first, sigsFirst);
    }

    function test_theSweepNonceIsOnlySpentBySweeps() public {
        // A refused sweep leaves the nonce where it was, so the same signatures can be sent again once it can pay.
        (address[] memory to, uint256[] memory amounts) = _trio(11 ether, 0, 0);
        (ThresholdMinter.Sweep memory s, bytes[] memory sigs) = _signedSweep(to, amounts);
        vm.expectRevert(ThresholdMinter.SweepFailed.selector);
        minter.sweep(s, sigs);
        assertEq(minter.sweepNonce(), 0);
        vm.deal(address(minter), 11 ether);
        minter.sweep(s, sigs);
        assertEq(op1.balance, 11 ether);
        assertEq(minter.sweepNonce(), 1);
    }

    // ------------------------------------------------------------ all or nothing

    function test_aRecipientThatRefusesStopsTheWholeSweep() public {
        RefusingRecipient refuses = new RefusingRecipient();
        address[] memory to = new address[](3);
        uint256[] memory amounts = new uint256[](3);
        to[0] = op1;
        to[1] = address(refuses);
        to[2] = op2;
        amounts[0] = 1 ether;
        amounts[1] = 1 ether;
        amounts[2] = 1 ether;
        (ThresholdMinter.Sweep memory s, bytes[] memory sigs) = _signedSweep(to, amounts);
        vm.expectRevert(ThresholdMinter.SweepFailed.selector);
        minter.sweep(s, sigs);
        assertEq(op1.balance, 0);
        assertEq(op2.balance, 0);
        assertEq(address(refuses).balance, 0);
        assertEq(address(minter).balance, 10 ether);
        assertEq(minter.sweepNonce(), 0);
    }

    function test_aSweepLargerThanTheBalanceFailsWithoutPayingAnyone() public {
        // The first payment would fit; the second would not.
        (address[] memory to, uint256[] memory amounts) = _trio(6 ether, 6 ether, 0);
        (ThresholdMinter.Sweep memory s, bytes[] memory sigs) = _signedSweep(to, amounts);
        vm.expectRevert(ThresholdMinter.SweepFailed.selector);
        minter.sweep(s, sigs);
        assertEq(op1.balance, 0);
        assertEq(op2.balance, 0);
        assertEq(address(minter).balance, 10 ether);
        assertEq(minter.sweepNonce(), 0);
    }

    function test_aSweepToTheMinterItselfFails() public {
        (address[] memory to, uint256[] memory amounts) = _pay(address(minter), 1 ether);
        (ThresholdMinter.Sweep memory s, bytes[] memory sigs) = _signedSweep(to, amounts);
        vm.expectRevert(ThresholdMinter.SweepFailed.selector);
        minter.sweep(s, sigs);
    }

    function test_aSweepToAListedTokenFails() public {
        address token = _list();
        (address[] memory to, uint256[] memory amounts) = _pay(token, 1 ether);
        (ThresholdMinter.Sweep memory s, bytes[] memory sigs) = _signedSweep(to, amounts);
        vm.expectRevert(ThresholdMinter.SweepFailed.selector);
        minter.sweep(s, sigs);
    }

    // ------------------------------------------------------------ re-entrancy

    /// The recipient is paid, then calls the sweep again with the very same arguments from inside its receive().
    /// The nonce was spent before the payment, so the second call is refused and the recipient is paid once.
    function test_aRecipientCannotReplayTheSweepThatIsPayingIt() public {
        ReenteringRecipient greedy = new ReenteringRecipient(address(minter));
        address[] memory to = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        to[0] = address(greedy);
        to[1] = op1;
        amounts[0] = 1 ether;
        amounts[1] = 1 ether;
        (ThresholdMinter.Sweep memory s, bytes[] memory sigs) = _signedSweep(to, amounts);
        greedy.arm(abi.encodeCall(ThresholdMinter.sweep, (s, sigs)));
        minter.sweep(s, sigs);
        assertTrue(greedy.reentered());
        assertFalse(greedy.replayOk());
        assertEq(greedy.replayError(), ThresholdMinter.BadNonce.selector);
        assertEq(greedy.received(), 1 ether);
        assertEq(address(greedy).balance, 1 ether);
        assertEq(op1.balance, 1 ether);
        assertEq(address(minter).balance, 8 ether);
        assertEq(minter.sweepNonce(), 1);
    }

    /// The last recipient in the list gets the same answer: the nonce does not wait for the loop to finish.
    function test_theLastRecipientCannotReplayItEither() public {
        ReenteringRecipient greedy = new ReenteringRecipient(address(minter));
        address[] memory to = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        to[0] = op1;
        to[1] = address(greedy);
        amounts[0] = 1 ether;
        amounts[1] = 1 ether;
        (ThresholdMinter.Sweep memory s, bytes[] memory sigs) = _signedSweep(to, amounts);
        greedy.arm(abi.encodeCall(ThresholdMinter.sweep, (s, sigs)));
        minter.sweep(s, sigs);
        assertEq(greedy.replayError(), ThresholdMinter.BadNonce.selector);
        assertEq(address(minter).balance, 8 ether);
    }

    // ------------------------------------------------------------ what a sweep must look like

    function test_sweepRejectsNoEntries() public {
        (ThresholdMinter.Sweep memory s, bytes[] memory sigs) = _signedSweep(new address[](0), new uint256[](0));
        vm.expectRevert(ThresholdMinter.BadSweep.selector);
        minter.sweep(s, sigs);
    }

    function test_sweepRejectsMoreThanThirtyTwoEntries() public {
        (address[] memory to, uint256[] memory amounts) = _same(op1, 1, 33);
        (ThresholdMinter.Sweep memory s, bytes[] memory sigs) = _signedSweep(to, amounts);
        vm.expectRevert(ThresholdMinter.BadSweep.selector);
        minter.sweep(s, sigs);
    }

    function test_sweepRejectsUnequalLengths() public {
        (address[] memory to,) = _same(op1, 1, 3);
        (, uint256[] memory two) = _same(op1, 1, 2);
        (ThresholdMinter.Sweep memory s, bytes[] memory sigs) = _signedSweep(to, two);
        vm.expectRevert(ThresholdMinter.BadSweep.selector);
        minter.sweep(s, sigs);
        (address[] memory few,) = _same(op1, 1, 2);
        (, uint256[] memory many) = _same(op1, 1, 3);
        (ThresholdMinter.Sweep memory t, bytes[] memory sigsT) = _signedSweep(few, many);
        vm.expectRevert(ThresholdMinter.BadSweep.selector);
        minter.sweep(t, sigsT);
    }

    function test_sweepRejectsAZeroAddressAnywhere() public {
        for (uint256 at = 0; at < 3; at++) {
            (address[] memory to, uint256[] memory amounts) = _trio(1 ether, 1 ether, 1 ether);
            to[at] = address(0);
            (ThresholdMinter.Sweep memory s, bytes[] memory sigs) = _signedSweep(to, amounts);
            vm.expectRevert(ThresholdMinter.BadSweep.selector);
            minter.sweep(s, sigs);
        }
        assertEq(address(minter).balance, 10 ether);
        assertEq(minter.sweepNonce(), 0);
    }

    // ------------------------------------------------------------ signatures

    function test_sweepRejectsOneSignature() public {
        (address[] memory to, uint256[] memory amounts) = _trio(1 ether, 0, 0);
        ThresholdMinter.Sweep memory s = ThresholdMinter.Sweep({to: to, amounts: amounts, nonce: 0});
        bytes[] memory sigs = _one(_sweepDigest(s));
        vm.expectRevert(ThresholdMinter.NotEnoughSignatures.selector);
        minter.sweep(s, sigs);
    }

    function test_oneSignerCannotSweepAlone() public {
        (address[] memory to, uint256[] memory amounts) = _trio(1 ether, 0, 0);
        ThresholdMinter.Sweep memory s = ThresholdMinter.Sweep({to: to, amounts: amounts, nonce: 0});
        vm.prank(signers[0]);
        vm.expectRevert(ThresholdMinter.NotEnoughSignatures.selector);
        minter.sweep(s, new bytes[](0));
    }

    function test_sweepRejectsOutsider() public {
        (address[] memory to, uint256[] memory amounts) = _trio(1 ether, 0, 0);
        ThresholdMinter.Sweep memory s = ThresholdMinter.Sweep({to: to, amounts: amounts, nonce: 0});
        bytes[] memory sigs = _withOutsider(_sweepDigest(s));
        vm.expectRevert(ThresholdMinter.BadSignature.selector);
        minter.sweep(s, sigs);
    }

    function test_sweepRejectsADuplicateSigner() public {
        (address[] memory to, uint256[] memory amounts) = _trio(1 ether, 0, 0);
        ThresholdMinter.Sweep memory s = ThresholdMinter.Sweep({to: to, amounts: amounts, nonce: 0});
        uint256[] memory dup = new uint256[](2);
        dup[0] = 2;
        dup[1] = 2;
        bytes[] memory sigs = _sign(_sweepDigest(s), dup);
        vm.expectRevert(ThresholdMinter.SignersNotSorted.selector);
        minter.sweep(s, sigs);
    }

    function test_sweepRejectsSignaturesForOtherAmounts() public {
        (address[] memory to, uint256[] memory amounts) = _trio(1 ether, 0, 0);
        (ThresholdMinter.Sweep memory signed, bytes[] memory sigs) = _signedSweep(to, amounts);
        amounts[0] = 9 ether;
        ThresholdMinter.Sweep memory sent = ThresholdMinter.Sweep({to: to, amounts: amounts, nonce: signed.nonce});
        vm.expectRevert(ThresholdMinter.BadSignature.selector);
        minter.sweep(sent, sigs);
        assertEq(op1.balance, 0);
    }

    function test_sweepRejectsSignaturesForOtherRecipients() public {
        (address[] memory to, uint256[] memory amounts) = _trio(1 ether, 0, 0);
        (ThresholdMinter.Sweep memory signed, bytes[] memory sigs) = _signedSweep(to, amounts);
        to[0] = makeAddr("thief");
        ThresholdMinter.Sweep memory sent = ThresholdMinter.Sweep({to: to, amounts: amounts, nonce: signed.nonce});
        vm.expectRevert(ThresholdMinter.BadSignature.selector);
        minter.sweep(sent, sigs);
    }

    function test_sweepRejectsSignaturesWithTheRecipientsInAnotherOrder() public {
        (address[] memory to, uint256[] memory amounts) = _trio(1 ether, 2 ether, 3 ether);
        (ThresholdMinter.Sweep memory signed, bytes[] memory sigs) = _signedSweep(to, amounts);
        (to[0], to[1]) = (to[1], to[0]);
        ThresholdMinter.Sweep memory sent = ThresholdMinter.Sweep({to: to, amounts: amounts, nonce: signed.nonce});
        vm.expectRevert(ThresholdMinter.BadSignature.selector);
        minter.sweep(sent, sigs);
    }

    // ------------------------------------------------------------ fuzz

    /// Any number of payouts to any of eight addresses (so some repeat): each address ends up with exactly the sum
    /// of what was signed for it, and the minter with exactly what is left.
    function testFuzz_sweepPaysExactlyWhatWasSigned(uint8 count, uint256 seed) public {
        uint256 n = bound(count, 1, 32);
        address[] memory to = new address[](n);
        uint256[] memory amounts = new uint256[](n);
        uint256[8] memory expected;
        uint256 total;
        for (uint256 i = 0; i < n; i++) {
            uint256 who = uint256(keccak256(abi.encode(seed, "to", i))) % 8;
            to[i] = address(uint160(0x100000 + who));
            amounts[i] = uint256(keccak256(abi.encode(seed, "amount", i))) % 0.3 ether;
            expected[who] += amounts[i];
            total += amounts[i];
        }
        (ThresholdMinter.Sweep memory s, bytes[] memory sigs) = _signedSweep(to, amounts);
        minter.sweep(s, sigs);
        uint256 paid;
        for (uint256 who = 0; who < 8; who++) {
            assertEq(address(uint160(0x100000 + who)).balance, expected[who]);
            paid += address(uint160(0x100000 + who)).balance;
        }
        assertEq(paid, total);
        assertEq(address(minter).balance, 10 ether - total);
        assertEq(minter.sweepNonce(), 1);
    }
}
