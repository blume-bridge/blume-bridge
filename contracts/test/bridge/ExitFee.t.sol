// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {BridgeBase} from "./BridgeBase.sol";
import {StubMinter} from "./Mocks.sol";
import {ThresholdMinter} from "../../src/bridge/ThresholdMinter.sol";
import {BridgeToken} from "../../src/bridge/BridgeToken.sol";

/// The exit fee: what a burn must carry, where it goes, who may change it, and who may send XRP to the minter.
contract ExitFeeTest is BridgeBase {
    address token;
    address alice;

    function setUp() public override {
        super.setUp();
        token = _list();
        alice = makeAddr("alice");
        vm.deal(alice, 100 ether);
        _mintTo(alice, 500e18, keccak256("lock-1"));
    }

    // ------------------------------------------------------------ the fee itself

    function test_theFeeAndItsCeiling() public {
        assertEq(minter.burnFee(), FEE);
        assertEq(minter.MAX_BURN_FEE(), 1 ether);
        assertEq(new ThresholdMinter(signers, 2, 1 days, 1 ether).burnFee(), 1 ether);
        assertEq(new ThresholdMinter(signers, 2, 1 days, 0).burnFee(), 0);
        vm.expectRevert(ThresholdMinter.BadFee.selector);
        new ThresholdMinter(signers, 2, 1 days, 1 ether + 1);
    }

    function test_burnPassesTheFeeToTheMinter() public {
        uint256 before = alice.balance;
        vm.expectEmit(true, true, false, true, token);
        emit BridgeToken.Burn(alice, 100e18, R_ADDRESS, 1);
        vm.prank(alice);
        uint256 nonce = BridgeToken(token).burn{value: FEE}(100e18, R_ADDRESS);
        assertEq(nonce, 1);
        assertEq(address(minter).balance, FEE);
        assertEq(token.balance, 0);
        assertEq(alice.balance, before - FEE);
        assertEq(BridgeToken(token).balanceOf(alice), 400e18);
        assertEq(BridgeToken(token).totalSupply(), 400e18);
        assertEq(BridgeToken(token).burnCount(), 1);
    }

    function test_burnRejectsTooLittle() public {
        vm.prank(alice);
        vm.expectRevert(BridgeToken.BadFeePayment.selector);
        BridgeToken(token).burn{value: FEE - 1}(100e18, R_ADDRESS);
    }

    function test_burnRejectsTooMuch() public {
        vm.prank(alice);
        vm.expectRevert(BridgeToken.BadFeePayment.selector);
        BridgeToken(token).burn{value: FEE + 1}(100e18, R_ADDRESS);
    }

    function test_burnRejectsNoValueWhenThereIsAFee() public {
        vm.prank(alice);
        vm.expectRevert(BridgeToken.BadFeePayment.selector);
        BridgeToken(token).burn(100e18, R_ADDRESS);
    }

    function test_aRefusedBurnChangesNothing() public {
        uint256 xrpBefore = alice.balance;
        vm.prank(alice);
        vm.expectRevert(BridgeToken.BadFeePayment.selector);
        BridgeToken(token).burn{value: 2 * FEE}(100e18, R_ADDRESS);
        assertEq(BridgeToken(token).balanceOf(alice), 500e18);
        assertEq(BridgeToken(token).totalSupply(), 500e18);
        assertEq(BridgeToken(token).burnCount(), 0);
        assertEq(address(minter).balance, 0);
        assertEq(token.balance, 0);
        assertEq(alice.balance, xrpBefore);
    }

    function test_aFeeOfZeroMeansNoValueAtAll() public {
        _setFee(0);
        vm.prank(alice);
        BridgeToken(token).burn(10e18, R_ADDRESS);
        vm.prank(alice);
        vm.expectRevert(BridgeToken.BadFeePayment.selector);
        BridgeToken(token).burn{value: 1}(10e18, R_ADDRESS);
        assertEq(address(minter).balance, 0);
        assertEq(BridgeToken(token).burnCount(), 1);
    }

    function test_feesAccumulateAcrossBurnsAndAcrossTokens() public {
        // A second listed token pays into the same minter.
        bytes32 tokenId2 = keccak256("SECOND");
        ThresholdMinter.Listing memory l = ThresholdMinter.Listing({tokenId: tokenId2, name: "Second", symbol: "SND", imageURI: "", dailyCap: CAP});
        address second = minter.listToken(l, _sign(_listDigest(l), _two()));
        ThresholdMinter.Mint memory m = ThresholdMinter.Mint({tokenId: tokenId2, to: alice, amount: 10e18, srcTx: keccak256("lock-2")});
        minter.mint(m, _sign(_mintDigest(m), _two()));
        vm.startPrank(alice);
        BridgeToken(token).burn{value: FEE}(1e18, R_ADDRESS);
        BridgeToken(token).burn{value: FEE}(1e18, R_ADDRESS);
        BridgeToken(second).burn{value: FEE}(1e18, R_ADDRESS);
        vm.stopPrank();
        assertEq(address(minter).balance, 3 * FEE);
        assertEq(token.balance, 0);
        assertEq(second.balance, 0);
        assertEq(BridgeToken(token).burnCount(), 2);
        assertEq(BridgeToken(second).burnCount(), 1);
    }

    function test_aBurnByAnAccountWithNoTokensFailsAndKeepsItsXrp() public {
        address broke = makeAddr("broke");
        vm.deal(broke, 1 ether);
        vm.prank(broke);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, broke, 0, 1));
        BridgeToken(token).burn{value: FEE}(1, R_ADDRESS);
        assertEq(broke.balance, 1 ether);
        assertEq(address(minter).balance, 0);
    }

    /// For any fee up to the ceiling and any value sent, a burn goes through exactly when the value is the fee.
    function testFuzz_aBurnPassesExactlyWhenTheValueIsTheFee(uint256 fee, uint256 sent, bool exact) public {
        fee = bound(fee, 0, 1 ether);
        sent = exact ? fee : bound(sent, 0, 2 ether);
        minter = new ThresholdMinter(signers, 2, 1 days, fee);
        token = _list();
        _mintTo(alice, 10e18, keccak256("fuzz"));
        vm.prank(alice);
        if (sent != fee) vm.expectRevert(BridgeToken.BadFeePayment.selector);
        BridgeToken(token).burn{value: sent}(1e18, R_ADDRESS);
        assertEq(address(minter).balance, sent == fee ? fee : 0);
        assertEq(BridgeToken(token).burnCount(), sent == fee ? 1 : 0);
    }

    // ------------------------------------------------------------ changing the fee

    function test_setBurnFeeChangesTheFee() public {
        ThresholdMinter.Fee memory f = ThresholdMinter.Fee({burnFee: 0.5 ether, nonce: 0});
        bytes[] memory sigs = _sign(_feeDigest(f), _two());
        vm.expectEmit(false, false, false, true, address(minter));
        emit ThresholdMinter.BurnFeeSet(FEE, 0.5 ether);
        minter.setBurnFee(f, sigs);
        assertEq(minter.burnFee(), 0.5 ether);
        assertEq(minter.feeNonce(), 1);
    }

    function test_theNewFeeAppliesToTheNextBurn() public {
        _setFee(0.5 ether);
        vm.prank(alice);
        vm.expectRevert(BridgeToken.BadFeePayment.selector);
        BridgeToken(token).burn{value: FEE}(1e18, R_ADDRESS);
        vm.prank(alice);
        BridgeToken(token).burn{value: 0.5 ether}(1e18, R_ADDRESS);
        assertEq(address(minter).balance, 0.5 ether);
        // The fee already collected is not touched by the change.
        _setFee(0.1 ether);
        assertEq(address(minter).balance, 0.5 ether);
    }

    function test_setBurnFeeCannotBeReplayed() public {
        ThresholdMinter.Fee memory f = ThresholdMinter.Fee({burnFee: 0.5 ether, nonce: 0});
        bytes[] memory sigs = _sign(_feeDigest(f), _two());
        minter.setBurnFee(f, sigs);
        _setFee(0.1 ether);
        // The old message cannot put the fee back: its nonce is spent.
        vm.expectRevert(ThresholdMinter.BadNonce.selector);
        minter.setBurnFee(f, sigs);
        assertEq(minter.burnFee(), 0.1 ether);
    }

    function test_setBurnFeeNoncesRunInOrder() public {
        ThresholdMinter.Fee memory first = ThresholdMinter.Fee({burnFee: 0.5 ether, nonce: 0});
        ThresholdMinter.Fee memory second = ThresholdMinter.Fee({burnFee: 0.1 ether, nonce: 1});
        bytes[] memory sigsFirst = _sign(_feeDigest(first), _two());
        bytes[] memory sigsSecond = _sign(_feeDigest(second), _two());
        vm.expectRevert(ThresholdMinter.BadNonce.selector);
        minter.setBurnFee(second, sigsSecond);
        minter.setBurnFee(first, sigsFirst);
        minter.setBurnFee(second, sigsSecond);
        assertEq(minter.burnFee(), 0.1 ether);
        assertEq(minter.feeNonce(), 2);
    }

    function test_setBurnFeeRefusesAFeeAboveTheCeiling() public {
        ThresholdMinter.Fee memory tooHigh = ThresholdMinter.Fee({burnFee: 1 ether + 1, nonce: 0});
        bytes[] memory sigs = _sign(_feeDigest(tooHigh), _two());
        vm.expectRevert(ThresholdMinter.BadFee.selector);
        minter.setBurnFee(tooHigh, sigs);
        assertEq(minter.burnFee(), FEE);
        assertEq(minter.feeNonce(), 0);
        // The ceiling itself is allowed.
        _setFee(1 ether);
        assertEq(minter.burnFee(), 1 ether);
        vm.prank(alice);
        BridgeToken(token).burn{value: 1 ether}(1e18, R_ADDRESS);
    }

    function test_setBurnFeeToZeroSwitchesTheFeeOff() public {
        _setFee(0);
        assertEq(minter.burnFee(), 0);
        assertEq(minter.feeNonce(), 1);
    }

    function test_setBurnFeeRejectsOneSignature() public {
        ThresholdMinter.Fee memory f = ThresholdMinter.Fee({burnFee: 0.5 ether, nonce: 0});
        bytes[] memory sigs = _one(_feeDigest(f));
        vm.expectRevert(ThresholdMinter.NotEnoughSignatures.selector);
        minter.setBurnFee(f, sigs);
    }

    function test_setBurnFeeRejectsOutsider() public {
        ThresholdMinter.Fee memory f = ThresholdMinter.Fee({burnFee: 0.5 ether, nonce: 0});
        bytes[] memory sigs = _withOutsider(_feeDigest(f));
        vm.expectRevert(ThresholdMinter.BadSignature.selector);
        minter.setBurnFee(f, sigs);
    }

    function test_setBurnFeeRejectsADuplicateSigner() public {
        ThresholdMinter.Fee memory f = ThresholdMinter.Fee({burnFee: 0.5 ether, nonce: 0});
        uint256[] memory dup = new uint256[](2);
        dup[0] = 1;
        dup[1] = 1;
        bytes[] memory sigs = _sign(_feeDigest(f), dup);
        vm.expectRevert(ThresholdMinter.SignersNotSorted.selector);
        minter.setBurnFee(f, sigs);
    }

    function test_setBurnFeeRejectsSignaturesForAnotherFee() public {
        ThresholdMinter.Fee memory signed = ThresholdMinter.Fee({burnFee: 0.1 ether, nonce: 0});
        ThresholdMinter.Fee memory sent = ThresholdMinter.Fee({burnFee: 0.9 ether, nonce: 0});
        bytes[] memory sigs = _sign(_feeDigest(signed), _two());
        vm.expectRevert(ThresholdMinter.BadSignature.selector);
        minter.setBurnFee(sent, sigs);
        assertEq(minter.burnFee(), FEE);
    }

    function test_oneSignerCannotSetTheFeeAlone() public {
        ThresholdMinter.Fee memory f = ThresholdMinter.Fee({burnFee: 0, nonce: 0});
        vm.prank(signers[0]);
        vm.expectRevert(ThresholdMinter.NotEnoughSignatures.selector);
        minter.setBurnFee(f, new bytes[](0));
    }

    function testFuzz_setBurnFeeHonoursTheCeiling(uint256 fee) public {
        ThresholdMinter.Fee memory f = ThresholdMinter.Fee({burnFee: fee, nonce: 0});
        bytes[] memory sigs = _sign(_feeDigest(f), _two());
        bool allowed = fee <= 1 ether;
        if (!allowed) vm.expectRevert(ThresholdMinter.BadFee.selector);
        minter.setBurnFee(f, sigs);
        assertEq(minter.burnFee(), allowed ? fee : FEE);
        assertEq(minter.feeNonce(), allowed ? 1 : 0);
    }

    // ------------------------------------------------------------ who may send XRP in

    function test_theMinterRefusesXrpFromAnOrdinaryAccount() public {
        vm.prank(alice);
        (bool ok, bytes memory ret) = address(minter).call{value: 1 ether}("");
        assertFalse(ok);
        assertEq(bytes4(ret), ThresholdMinter.NotToken.selector);
        assertEq(address(minter).balance, 0);
    }

    function test_theMinterRefusesXrpFromItsOwnFactoryAndSigners() public {
        address factory = address(minter.factory());
        vm.deal(factory, 1 ether);
        vm.prank(factory);
        (bool okFactory,) = address(minter).call{value: 1}("");
        assertFalse(okFactory);
        vm.deal(signers[0], 1 ether);
        vm.prank(signers[0]);
        (bool okSigner,) = address(minter).call{value: 1}("");
        assertFalse(okSigner);
        assertEq(address(minter).balance, 0);
    }

    function test_theMinterTakesXrpFromAListedToken() public {
        assertTrue(minter.isToken(token));
        vm.deal(token, 1 ether);
        vm.prank(token);
        (bool ok,) = address(minter).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(minter).balance, 1 ether);
    }

    function test_theMinterRefusesXrpWithCalldata() public {
        vm.deal(token, 1 ether);
        vm.prank(token);
        (bool ok,) = address(minter).call{value: 1}(hex"deadbeef");
        assertFalse(ok);
        assertEq(address(minter).balance, 0);
    }

    /// A token built by hand that names this minter as its minter is still not a listed token: it cannot push XRP in,
    /// so a burn on it fails instead of leaving the fee anywhere.
    function test_aTokenThatIsNotListedCannotPushFeesIn() public {
        BridgeToken fake = new BridgeToken("Fake", "FAKE", "", address(minter));
        assertFalse(minter.isToken(address(fake)));
        vm.prank(address(minter));
        fake.mint(address(this), 10);
        vm.expectRevert(BridgeToken.FeeTransferFailed.selector);
        fake.burn{value: FEE}(1, R_ADDRESS);
        assertEq(fake.balanceOf(address(this)), 10);
        assertEq(address(minter).balance, 0);
        assertEq(address(fake).balance, 0);
    }

    // ------------------------------------------------------------ the forward, from the token's side

    function _stubToken(uint256 fee) internal returns (StubMinter stub, BridgeToken t) {
        stub = new StubMinter(fee);
        t = new BridgeToken("Stub", "STUB", "", address(stub));
        stub.setToken(t);
        stub.mintTo(address(this), 100);
    }

    function test_aBurnIsUndoneWhenTheMinterRefusesTheFee() public {
        (StubMinter stub, BridgeToken t) = _stubToken(FEE);
        stub.setRefuse(true);
        vm.expectRevert(BridgeToken.FeeTransferFailed.selector);
        t.burn{value: FEE}(10, R_ADDRESS);
        assertEq(t.balanceOf(address(this)), 100);
        assertEq(t.totalSupply(), 100);
        assertEq(t.burnCount(), 0);
        assertEq(address(t).balance, 0);
        assertEq(address(stub).balance, 0);
    }

    /// The burn is recorded before the fee moves, so a minter that burns again from inside the transfer gets the next
    /// nonce and its event comes after the first: nothing can take the first burn's number or reorder the two.
    function test_theFeeForwardCannotReorderBurns() public {
        (StubMinter stub, BridgeToken t) = _stubToken(FEE);
        stub.mintTo(address(stub), 1);
        stub.setBurnAgain(true);
        vm.recordLogs();
        uint256 outer = t.burn{value: FEE}(5, R_ADDRESS);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(outer, 1);
        assertEq(stub.innerNonce(), 2);
        uint256 seen;
        uint256[] memory order = new uint256[](2);
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == BridgeToken.Burn.selector) order[seen++] = uint256(logs[i].topics[2]);
        }
        assertEq(seen, 2);
        assertEq(order[0], 1);
        assertEq(order[1], 2);
        assertEq(t.burnCount(), 2);
        assertEq(t.balanceOf(address(this)), 95);
        assertEq(t.balanceOf(address(stub)), 0);
        assertEq(t.totalSupply(), 95);
        assertEq(address(t).balance, 0);
        assertEq(stub.timesPaid(), 2);
    }

    // ------------------------------------------------------------ the whole path

    function test_listMintBurnWithFeeThenSweep() public {
        address bob = makeAddr("bob");
        vm.deal(bob, 10 ether);
        _mintTo(bob, 200e18, keccak256("lock-2"));

        vm.startPrank(alice);
        BridgeToken(token).burn{value: FEE}(100e18, R_ADDRESS);
        BridgeToken(token).burn{value: FEE}(50e18, X_ADDRESS);
        vm.stopPrank();
        vm.prank(bob);
        BridgeToken(token).burn{value: FEE}(200e18, T_ADDRESS);

        // Three burns, three fees: the minter holds exactly those and the token holds nothing.
        assertEq(address(minter).balance, 3 * FEE);
        assertEq(token.balance, 0);
        assertEq(alice.balance, 100 ether - 2 * FEE);
        assertEq(bob.balance, 10 ether - FEE);
        assertEq(BridgeToken(token).totalSupply(), 350e18);

        // 0.75 XRP split 70/30: three operators take 0.175 each, the treasury 0.225.
        address[] memory to = new address[](4);
        uint256[] memory amounts = new uint256[](4);
        for (uint256 i = 0; i < 3; i++) {
            to[i] = makeAddr(string.concat("operator", vm.toString(i)));
            amounts[i] = 0.175 ether;
        }
        to[3] = makeAddr("treasury");
        amounts[3] = 0.225 ether;
        (ThresholdMinter.Sweep memory s, bytes[] memory sigs) = _signedSweep(to, amounts);
        minter.sweep(s, sigs);

        assertEq(address(minter).balance, 0);
        for (uint256 i = 0; i < 3; i++) {
            assertEq(to[i].balance, 0.175 ether);
        }
        assertEq(to[3].balance, 0.225 ether);
        assertEq(minter.sweepNonce(), 1);

        // Fees keep arriving after a sweep, and the next one is the next nonce.
        vm.prank(alice);
        BridgeToken(token).burn{value: FEE}(1e18, R_ADDRESS);
        assertEq(address(minter).balance, FEE);
        (address[] memory to2, uint256[] memory amounts2) = _pay(to[3], FEE);
        (ThresholdMinter.Sweep memory s2, bytes[] memory sigs2) = _signedSweep(to2, amounts2);
        assertEq(s2.nonce, 1);
        minter.sweep(s2, sigs2);
        assertEq(address(minter).balance, 0);
        assertEq(to[3].balance, 0.225 ether + FEE);
    }
}
