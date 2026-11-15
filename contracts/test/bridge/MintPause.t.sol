// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BridgeBase} from "./BridgeBase.sol";
import {ThresholdMinter} from "../../src/bridge/ThresholdMinter.sol";
import {BridgeToken} from "../../src/bridge/BridgeToken.sol";

/// The mint pause: any one signer stops mints, k signers restart them, and nothing but `mint` is affected.
contract MintPauseTest is BridgeBase {
    address token;
    address alice;

    function setUp() public override {
        super.setUp();
        token = _list();
        alice = makeAddr("alice");
        vm.deal(alice, 10 ether);
        _mintTo(alice, 100e18, keccak256("lock-0"));
    }

    // ------------------------------------------------------------ pausing

    function testFuzz_anyCurrentSignerCanPause(uint8 pick) public {
        uint256 i = pick % signers.length;
        vm.expectEmit(false, false, false, true, address(minter));
        emit ThresholdMinter.Paused(signers[i]);
        _pauseBy(i);
        assertTrue(minter.paused());
        assertEq(minter.resumeNonce(), 0);
    }

    function test_pauseRefusesAnyoneWhoIsNotASigner() public {
        vm.expectRevert(ThresholdMinter.NotSigner.selector);
        minter.pause();
        vm.prank(alice);
        vm.expectRevert(ThresholdMinter.NotSigner.selector);
        minter.pause();
        vm.prank(token);
        vm.expectRevert(ThresholdMinter.NotSigner.selector);
        minter.pause();
        vm.prank(address(minter.factory()));
        vm.expectRevert(ThresholdMinter.NotSigner.selector);
        minter.pause();
        assertFalse(minter.paused());
    }

    function test_pauseWhenAlreadyPausedReverts() public {
        _pauseBy(0);
        vm.prank(signers[0]);
        vm.expectRevert(ThresholdMinter.AlreadyPaused.selector);
        minter.pause();
        vm.prank(signers[1]);
        vm.expectRevert(ThresholdMinter.AlreadyPaused.selector);
        minter.pause();
        assertTrue(minter.paused());
    }

    // ------------------------------------------------------------ mints stop

    function test_mintRevertsIsPausedWhilePaused() public {
        (ThresholdMinter.Mint memory m, bytes[] memory sigs) = _signedMint(10e18, keccak256("held"));
        _pauseBy(1);
        vm.expectRevert(ThresholdMinter.IsPaused.selector);
        minter.mint(m, sigs);
        // Nothing was used up: not the lock, not the day's cap, not a single token.
        assertFalse(minter.minted(keccak256("held")));
        (, uint256 used,) = minter.caps(token);
        assertEq(used, 100e18);
        assertEq(BridgeToken(token).balanceOf(address(1)), 0);
        // After a resume the very same signatures mint: the cluster only has to retry.
        _resume();
        minter.mint(m, sigs);
        assertEq(BridgeToken(token).balanceOf(address(1)), 10e18);
        assertTrue(minter.minted(keccak256("held")));
    }

    function test_theMintPauseIsCheckedBeforeAnythingElse() public {
        _pauseBy(0);
        // Unknown token, no signatures: still IsPaused, so the cluster can tell "wait" from "wrong".
        ThresholdMinter.Mint memory nothing = ThresholdMinter.Mint({tokenId: keccak256("nothing"), to: address(1), amount: 1, srcTx: keccak256("x")});
        vm.expectRevert(ThresholdMinter.IsPaused.selector);
        minter.mint(nothing, new bytes[](0));
        // An already-minted lock too.
        ThresholdMinter.Mint memory again = ThresholdMinter.Mint({tokenId: TOKEN, to: alice, amount: 100e18, srcTx: keccak256("lock-0")});
        bytes[] memory sigs = _sign(_mintDigest(again), _two());
        vm.expectRevert(ThresholdMinter.IsPaused.selector);
        minter.mint(again, sigs);
    }

    function test_thePauseStopsEveryToken() public {
        bytes32 tokenId2 = keccak256("SECOND");
        ThresholdMinter.Listing memory l = ThresholdMinter.Listing({tokenId: tokenId2, name: "Second", symbol: "SND", imageURI: "", dailyCap: CAP});
        minter.listToken(l, _sign(_listDigest(l), _two()));
        ThresholdMinter.Mint memory m = ThresholdMinter.Mint({tokenId: tokenId2, to: alice, amount: 1, srcTx: keccak256("second-lock")});
        bytes[] memory sigs = _sign(_mintDigest(m), _two());
        _pauseBy(2);
        vm.expectRevert(ThresholdMinter.IsPaused.selector);
        minter.mint(m, sigs);
    }

    // ------------------------------------------------------------ resuming

    function test_resumeRestartsMintsAndSpendsTheNonce() public {
        _pauseBy(0);
        vm.expectEmit(false, false, false, true, address(minter));
        emit ThresholdMinter.Resumed(0);
        _resume();
        assertFalse(minter.paused());
        assertEq(minter.resumeNonce(), 1);
        _mintTo(alice, 1e18, keccak256("after"));
        assertEq(BridgeToken(token).balanceOf(alice), 101e18);
    }

    function test_resumeNeedsKSignatures() public {
        _pauseBy(0);
        bytes[] memory one = _one(_resumeDigest(0));
        vm.expectRevert(ThresholdMinter.NotEnoughSignatures.selector);
        minter.resume(0, one);
        assertTrue(minter.paused());
    }

    function test_aSignerCannotResumeAlone() public {
        _pauseBy(0);
        vm.prank(signers[0]);
        vm.expectRevert(ThresholdMinter.NotEnoughSignatures.selector);
        minter.resume(0, new bytes[](0));
        assertTrue(minter.paused());
    }

    function test_resumeRefusesAnOutsider() public {
        _pauseBy(0);
        bytes[] memory sigs = _withOutsider(_resumeDigest(0));
        vm.expectRevert(ThresholdMinter.BadSignature.selector);
        minter.resume(0, sigs);
    }

    function test_resumeRefusesADuplicateSigner() public {
        _pauseBy(0);
        uint256[] memory dup = new uint256[](2);
        dup[0] = 0;
        dup[1] = 0;
        bytes[] memory sigs = _sign(_resumeDigest(0), dup);
        vm.expectRevert(ThresholdMinter.SignersNotSorted.selector);
        minter.resume(0, sigs);
    }

    function test_resumeRefusesAWrongNonce() public {
        _pauseBy(0);
        bytes[] memory sigs = _sign(_resumeDigest(1), _two());
        vm.expectRevert(ThresholdMinter.BadNonce.selector);
        minter.resume(1, sigs);
    }

    function test_resumeRefusesSignaturesForAnotherNonce() public {
        _pauseBy(0);
        bytes[] memory forNonceOne = _sign(_resumeDigest(1), _two());
        vm.expectRevert(ThresholdMinter.BadSignature.selector);
        minter.resume(0, forNonceOne);
    }

    function test_resumeWhenNotPausedReverts() public {
        bytes[] memory sigs = _sign(_resumeDigest(0), _two());
        vm.expectRevert(ThresholdMinter.NotPaused.selector);
        minter.resume(0, sigs);
        // Nothing was spent: the same signatures resume the next pause.
        assertEq(minter.resumeNonce(), 0);
        _pauseBy(0);
        minter.resume(0, sigs);
        assertFalse(minter.paused());
    }

    function test_resumeSignaturesWorkOnce() public {
        _pauseBy(0);
        bytes[] memory first = _sign(_resumeDigest(0), _two());
        minter.resume(0, first);
        _pauseBy(1);
        // A second pause cannot be undone with the first resume's signatures.
        vm.expectRevert(ThresholdMinter.BadNonce.selector);
        minter.resume(0, first);
        assertTrue(minter.paused());
        _resume();
        assertFalse(minter.paused());
        assertEq(minter.resumeNonce(), 2);
    }

    function test_theBridgeCanBePausedAndResumedAgainAndAgain() public {
        for (uint256 i = 0; i < 4; i++) {
            _pauseBy(i % signers.length);
            ThresholdMinter.Mint memory m = ThresholdMinter.Mint({tokenId: TOKEN, to: alice, amount: 1, srcTx: keccak256(abi.encode("round", i))});
            bytes[] memory sigs = _sign(_mintDigest(m), _two());
            vm.expectRevert(ThresholdMinter.IsPaused.selector);
            minter.mint(m, sigs);
            _resume();
            minter.mint(m, sigs);
        }
        assertEq(minter.resumeNonce(), 4);
        assertEq(BridgeToken(token).balanceOf(alice), 100e18 + 4);
    }

    // ------------------------------------------------------------ everything but mint keeps working

    function test_burnsKeepWorkingWhilePaused() public {
        _pauseBy(0);
        vm.expectEmit(true, true, false, true, token);
        emit BridgeToken.Burn(alice, 40e18, R_ADDRESS, 1);
        vm.prank(alice);
        BridgeToken(token).burn{value: FEE}(40e18, R_ADDRESS);
        vm.prank(alice);
        BridgeToken(token).burn{value: FEE}(10e18, X_ADDRESS);
        assertEq(BridgeToken(token).balanceOf(alice), 50e18);
        assertEq(address(minter).balance, 2 * FEE);
        assertEq(BridgeToken(token).burnCount(), 2);
    }

    function test_listingsAndUpdatesKeepWorkingWhilePaused() public {
        _pauseBy(0);
        bytes32 tokenId2 = keccak256("SECOND");
        ThresholdMinter.Listing memory l = ThresholdMinter.Listing({tokenId: tokenId2, name: "Second", symbol: "SND", imageURI: "", dailyCap: 0});
        address second = minter.listToken(l, _sign(_listDigest(l), _two()));
        assertTrue(minter.isToken(second));
        // A cap can be lowered to zero in the middle of an incident, and metadata can be corrected.
        _setCap(0);
        (uint256 perDay,,) = minter.caps(token);
        assertEq(perDay, 0);
        ThresholdMinter.Update memory u = _update("Petal Two", "PTL2", IMAGE_2, 0, 2);
        minter.updateToken(u, _sign(_updateDigest(u), _two()));
        assertEq(BridgeToken(token).name(), "Petal Two");
        // Raising the cap does not restart mints: the pause is separate.
        _setCap(CAP);
        (ThresholdMinter.Mint memory m, bytes[] memory sigs) = _signedMint(1, keccak256("still-held"));
        vm.expectRevert(ThresholdMinter.IsPaused.selector);
        minter.mint(m, sigs);
    }

    function test_feeChangesAndSweepsKeepWorkingWhilePaused() public {
        vm.prank(alice);
        BridgeToken(token).burn{value: FEE}(1e18, R_ADDRESS);
        _pauseBy(0);
        _setFee(0.1 ether);
        assertEq(minter.burnFee(), 0.1 ether);
        address operator = makeAddr("operator");
        (address[] memory to, uint256[] memory amounts) = _pay(operator, FEE);
        (ThresholdMinter.Sweep memory s, bytes[] memory sigs) = _signedSweep(to, amounts);
        minter.sweep(s, sigs);
        assertEq(operator.balance, FEE);
        assertEq(address(minter).balance, 0);
    }

    function test_rotationKeepsWorkingWhilePaused() public {
        _pauseBy(0);
        // Propose, cancel, propose again, execute: every step works under the pause.
        ThresholdMinter.Rotation memory r = _rotation(_nextSet(), 0, 0);
        minter.proposeRotation(r, _sign(_rotateDigest(r), _two()));
        minter.cancelRotation(_sign(_cancelDigest(minter.pendingRotation(), 1), _two()));
        ThresholdMinter.Rotation memory r2 = _rotation(_nextSet(), 0, 2);
        minter.proposeRotation(r2, _sign(_rotateDigest(r2), _two()));
        vm.warp(block.timestamp + 1 days);
        minter.executeRotation();
        assertTrue(minter.isSigner(address(0x1111)));
        assertTrue(minter.paused());
    }

    /// The way out of a hostile or lost key: rotate it away while paused. The new set restarts mints, and the removed
    /// signers can no longer pause or sign a resume.
    function test_aNewSignerSetTakesOverThePause() public {
        _pauseBy(0);
        (uint256[] memory nks, address[] memory next) = _sortedSet(0x9000, 2);
        ThresholdMinter.Rotation memory r = ThresholdMinter.Rotation({signers: next, threshold: 2, nonce: 0, seq: 0});
        minter.proposeRotation(r, _sign(_rotateDigest(r), _two()));
        vm.warp(block.timestamp + 1 days);
        minter.executeRotation();

        bytes32 digest = _resumeDigest(0);
        bytes[] memory oldSet = _sign(digest, _two());
        vm.expectRevert(ThresholdMinter.BadSignature.selector);
        minter.resume(0, oldSet);
        minter.resume(0, _signWith(nks, 2, digest));
        assertFalse(minter.paused());

        // A removed signer cannot pause any more; a new one can.
        vm.prank(signers[0]);
        vm.expectRevert(ThresholdMinter.NotSigner.selector);
        minter.pause();
        vm.prank(next[1]);
        minter.pause();
        assertTrue(minter.paused());
    }
}
