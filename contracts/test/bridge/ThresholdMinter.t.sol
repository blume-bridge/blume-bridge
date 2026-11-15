// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BridgeBase} from "./BridgeBase.sol";
import {ThresholdMinter} from "../../src/bridge/ThresholdMinter.sol";
import {BridgeToken} from "../../src/bridge/BridgeToken.sol";
import {TokenFactory} from "../../src/bridge/TokenFactory.sol";

/// Listing, minting, the daily cap, signer sets, rotation and metadata. The exit fee, sweeps, the pause and typed
/// data have their own files.
contract ThresholdMinterTest is BridgeBase {
    // ------------------------------------------------------------ setup

    function test_constructorRecordsItsParameters() public view {
        assertEq(minter.threshold(), 2);
        assertEq(minter.rotationDelay(), 1 days);
        assertEq(minter.burnFee(), FEE);
        assertEq(minter.feeNonce(), 0);
        assertEq(minter.sweepNonce(), 0);
        assertEq(minter.resumeNonce(), 0);
        assertFalse(minter.paused());
        address[] memory set = minter.signers();
        assertEq(set.length, 3);
        for (uint256 i = 0; i < set.length; i++) {
            assertEq(set[i], signers[i]);
            assertTrue(minter.isSigner(signers[i]));
        }
        assertFalse(minter.isSigner(address(this)));
        assertEq(TokenFactory(address(minter.factory())).minter(), address(minter));
    }

    function test_constructorRejectsBadSignerSets() public {
        address[] memory none = new address[](0);
        vm.expectRevert(ThresholdMinter.BadSignerSet.selector);
        new ThresholdMinter(none, 1, 1 days, FEE);

        address[] memory zero = new address[](2);
        zero[0] = address(0xA1);
        zero[1] = address(0);
        vm.expectRevert(ThresholdMinter.BadSignerSet.selector);
        new ThresholdMinter(zero, 1, 1 days, FEE);

        address[] memory dup = new address[](2);
        dup[0] = address(0xA1);
        dup[1] = address(0xA1);
        vm.expectRevert(ThresholdMinter.BadSignerSet.selector);
        new ThresholdMinter(dup, 1, 1 days, FEE);

        address[] memory two = new address[](2);
        two[0] = address(0xA1);
        two[1] = address(0xA2);
        vm.expectRevert(ThresholdMinter.BadSignerSet.selector);
        new ThresholdMinter(two, 0, 1 days, FEE);
        vm.expectRevert(ThresholdMinter.BadSignerSet.selector);
        new ThresholdMinter(two, 3, 1 days, FEE);

        // 32 signers is the most; one signer with k = 1 is the least.
        address[] memory many = new address[](33);
        for (uint256 i = 0; i < many.length; i++) many[i] = address(uint160(0xB000 + i));
        vm.expectRevert(ThresholdMinter.BadSignerSet.selector);
        new ThresholdMinter(many, 1, 1 days, FEE);
        address[] memory thirtyTwo = new address[](32);
        for (uint256 i = 0; i < thirtyTwo.length; i++) thirtyTwo[i] = many[i];
        assertEq(new ThresholdMinter(thirtyTwo, 32, 1 days, FEE).signers().length, 32);
        address[] memory one = new address[](1);
        one[0] = address(0xA1);
        assertEq(new ThresholdMinter(one, 1, 0, 0).threshold(), 1);
    }

    function test_fiveSignersNeedThree() public {
        (uint256[] memory ks, address[] memory addrs) = _sortedSet(0x5000, 5);
        ThresholdMinter five = new ThresholdMinter(addrs, 3, 1 days, 0);
        assertEq(five.threshold(), 3);
        assertEq(five.signers().length, 5);
        ThresholdMinter.Fee memory f = ThresholdMinter.Fee({burnFee: FEE, nonce: 0});
        bytes32 digest = _digestFor(five, keccak256(abi.encode(five.SET_BURN_FEE_TYPEHASH(), f.burnFee, f.nonce)));
        vm.expectRevert(ThresholdMinter.NotEnoughSignatures.selector);
        five.setBurnFee(f, _signWith(ks, 2, digest));
        five.setBurnFee(f, _signWith(ks, 5, digest));
        assertEq(five.burnFee(), FEE);
    }

    // ------------------------------------------------------------ listing and minting

    function test_listAndMint() public {
        address token = _list();
        assertEq(minter.tokens(TOKEN), token);
        assertTrue(minter.isToken(token));
        assertFalse(minter.isToken(address(this)));
        assertEq(BridgeToken(token).minter(), address(minter));
        ThresholdMinter.Mint memory m = ThresholdMinter.Mint({tokenId: TOKEN, to: address(0xBEEF), amount: 100e18, srcTx: keccak256("lock1")});
        minter.mint(m, _sign(_mintDigest(m), _two()));
        assertEq(BridgeToken(token).balanceOf(address(0xBEEF)), 100e18);
        assertTrue(minter.minted(keccak256("lock1")));
    }

    function test_listTokenRejectsAnExistingTokenId() public {
        _list();
        ThresholdMinter.Listing memory l = _listing("Petal Again", "PETAL2", IMAGE);
        bytes[] memory sigs = _sign(_listDigest(l), _two());
        vm.expectRevert(ThresholdMinter.TokenExists.selector);
        minter.listToken(l, sigs);
    }

    function test_listTokenRejectsOneSignature() public {
        ThresholdMinter.Listing memory l = _listing("Petal", "PETAL", IMAGE);
        bytes[] memory sigs = _one(_listDigest(l));
        vm.expectRevert(ThresholdMinter.NotEnoughSignatures.selector);
        minter.listToken(l, sigs);
        assertEq(minter.tokens(TOKEN), address(0));
    }

    function test_mintRejectsAnUnknownToken() public {
        (ThresholdMinter.Mint memory m, bytes[] memory sigs) = _signedMint(1, keccak256("x"));
        vm.expectRevert(ThresholdMinter.UnknownToken.selector);
        minter.mint(m, sigs);
    }

    function test_mintRejectsOneSignature() public {
        _list();
        ThresholdMinter.Mint memory m = ThresholdMinter.Mint({tokenId: TOKEN, to: address(1), amount: 1, srcTx: keccak256("x")});
        bytes[] memory sigs = _one(_mintDigest(m));
        vm.expectRevert(ThresholdMinter.NotEnoughSignatures.selector);
        minter.mint(m, sigs);
    }

    function test_mintRejectsDuplicateSigner() public {
        _list();
        ThresholdMinter.Mint memory m = ThresholdMinter.Mint({tokenId: TOKEN, to: address(1), amount: 1, srcTx: keccak256("x")});
        uint256[] memory dup = new uint256[](2);
        dup[0] = 0;
        dup[1] = 0;
        bytes[] memory sigs = _sign(_mintDigest(m), dup);
        vm.expectRevert(ThresholdMinter.SignersNotSorted.selector);
        minter.mint(m, sigs);
    }

    function test_mintRejectsSignaturesOutOfOrder() public {
        _list();
        ThresholdMinter.Mint memory m = ThresholdMinter.Mint({tokenId: TOKEN, to: address(1), amount: 1, srcTx: keccak256("x")});
        uint256[] memory backwards = new uint256[](2);
        backwards[0] = 1;
        backwards[1] = 0;
        bytes[] memory sigs = _sign(_mintDigest(m), backwards);
        vm.expectRevert(ThresholdMinter.SignersNotSorted.selector);
        minter.mint(m, sigs);
    }

    function test_mintRejectsOutsider() public {
        _list();
        ThresholdMinter.Mint memory m = ThresholdMinter.Mint({tokenId: TOKEN, to: address(1), amount: 1, srcTx: keccak256("x")});
        bytes[] memory sigs = _withOutsider(_mintDigest(m));
        vm.expectRevert(ThresholdMinter.BadSignature.selector);
        minter.mint(m, sigs);
    }

    function test_mintRejectsSignaturesForAnotherMessage() public {
        _list();
        ThresholdMinter.Mint memory signed = ThresholdMinter.Mint({tokenId: TOKEN, to: address(1), amount: 1, srcTx: keccak256("x")});
        ThresholdMinter.Mint memory sent = ThresholdMinter.Mint({tokenId: TOKEN, to: address(1), amount: 2, srcTx: keccak256("x")});
        bytes[] memory sigs = _sign(_mintDigest(signed), _two());
        vm.expectRevert(ThresholdMinter.BadSignature.selector);
        minter.mint(sent, sigs);
    }

    function test_moreThanThresholdSignaturesAreAccepted() public {
        _list();
        ThresholdMinter.Mint memory m = ThresholdMinter.Mint({tokenId: TOKEN, to: address(1), amount: 5, srcTx: keccak256("x")});
        minter.mint(m, _sign(_mintDigest(m), _three()));
        assertTrue(minter.minted(keccak256("x")));
    }

    function test_mintRejectsReplay() public {
        _list();
        ThresholdMinter.Mint memory m = ThresholdMinter.Mint({tokenId: TOKEN, to: address(1), amount: 1, srcTx: keccak256("x")});
        bytes[] memory sigs = _sign(_mintDigest(m), _two());
        minter.mint(m, sigs);
        vm.expectRevert(ThresholdMinter.AlreadyMinted.selector);
        minter.mint(m, sigs);
    }

    function test_dailyCap() public {
        _list();
        ThresholdMinter.Mint memory a = ThresholdMinter.Mint({tokenId: TOKEN, to: address(1), amount: 900e18, srcTx: keccak256("a")});
        minter.mint(a, _sign(_mintDigest(a), _two()));
        ThresholdMinter.Mint memory b = ThresholdMinter.Mint({tokenId: TOKEN, to: address(1), amount: 200e18, srcTx: keccak256("b")});
        bytes[] memory sigsB = _sign(_mintDigest(b), _two());
        vm.expectRevert(ThresholdMinter.CapExceeded.selector);
        minter.mint(b, sigsB);
        vm.warp(block.timestamp + 1 days);
        minter.mint(b, sigsB);
    }

    // ------------------------------------------------------------ what a daily cap means

    function test_capOfZeroTakesNoMints() public {
        address token = _listCapped(0);
        (uint256 perDay,,) = minter.caps(token);
        assertEq(perDay, 0);
        (ThresholdMinter.Mint memory m, bytes[] memory sigs) = _signedMint(1, keccak256("a"));
        vm.expectRevert(ThresholdMinter.CapExceeded.selector);
        minter.mint(m, sigs);
        assertFalse(minter.minted(keccak256("a")));
        // Not even a new day opens it.
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(ThresholdMinter.CapExceeded.selector);
        minter.mint(m, sigs);
        // An update that raises the cap opens it, and the very same signatures then mint.
        _setCap(10);
        minter.mint(m, sigs);
        assertEq(BridgeToken(token).balanceOf(address(1)), 1);
    }

    function test_updatingTheCapToZeroStopsMints() public {
        address token = _list();
        _mintTo(address(1), 100e18, keccak256("a"));
        _setCap(0);
        (ThresholdMinter.Mint memory m, bytes[] memory sigs) = _signedMint(1, keccak256("b"));
        vm.expectRevert(ThresholdMinter.CapExceeded.selector);
        minter.mint(m, sigs);
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(ThresholdMinter.CapExceeded.selector);
        minter.mint(m, sigs);
        assertEq(BridgeToken(token).totalSupply(), 100e18);
    }

    function test_uncappedTokenTakesAnyAmountAndCountsIt() public {
        assertEq(minter.UNCAPPED(), type(uint256).max);
        address token = _listCapped(type(uint256).max);
        _mintTo(address(1), 1e30, keccak256("a"));
        _mintTo(address(1), 7e40, keccak256("b"));
        (uint256 perDay, uint256 used,) = minter.caps(token);
        assertEq(perDay, type(uint256).max);
        assertEq(used, 1e30 + 7e40);
        assertEq(BridgeToken(token).balanceOf(address(1)), 1e30 + 7e40);
    }

    function test_uncappedCountingNeverOverflows() public {
        address token = _listCapped(type(uint256).max);
        _mintTo(address(this), type(uint256).max, keccak256("a"));
        BridgeToken(token).burn{value: FEE}(type(uint256).max, R_ADDRESS);
        // Today's total is already the largest number there is. One more mint still goes through, and the count holds there.
        _mintTo(address(this), 1, keccak256("b"));
        (, uint256 used,) = minter.caps(token);
        assertEq(used, type(uint256).max);
        assertEq(BridgeToken(token).balanceOf(address(this)), 1);
    }

    function test_loweringAnUncappedTokenCountsWhatWasMintedToday() public {
        address token = _listCapped(type(uint256).max);
        _mintTo(address(1), 500e18, keccak256("a"));
        _setCap(400e18);
        (ThresholdMinter.Mint memory m, bytes[] memory sigs) = _signedMint(1, keccak256("b"));
        vm.expectRevert(ThresholdMinter.CapExceeded.selector);
        minter.mint(m, sigs);
        // Midnight UTC starts the count over under the new cap.
        vm.warp(block.timestamp + 1 days);
        _mintTo(address(1), 400e18, keccak256("c"));
        vm.expectRevert(ThresholdMinter.CapExceeded.selector);
        minter.mint(m, sigs);
        assertEq(BridgeToken(token).balanceOf(address(1)), 900e18);
    }

    function test_raisingACapToUncappedLiftsTheLimit() public {
        address token = _list();
        _mintTo(address(1), CAP, keccak256("a"));
        (ThresholdMinter.Mint memory m, bytes[] memory sigs) = _signedMint(5000e18, keccak256("b"));
        vm.expectRevert(ThresholdMinter.CapExceeded.selector);
        minter.mint(m, sigs);
        _setCap(type(uint256).max);
        minter.mint(m, sigs);
        assertEq(BridgeToken(token).balanceOf(address(1)), CAP + 5000e18);
    }

    function test_aCapLoweredBelowTodaysMintsIsCapExceededNotAPanic() public {
        _list();
        _mintTo(address(1), 900e18, keccak256("a"));
        _setCap(300e18); // today's 900 now sits above the cap of 300
        (ThresholdMinter.Mint memory m, bytes[] memory sigs) = _signedMint(1, keccak256("b"));
        vm.expectRevert(ThresholdMinter.CapExceeded.selector);
        minter.mint(m, sigs);
    }

    function test_anOversizedAmountIsCapExceededNotAPanic() public {
        _list();
        (ThresholdMinter.Mint memory big, bytes[] memory sigsBig) = _signedMint(type(uint256).max, keccak256("a"));
        vm.expectRevert(ThresholdMinter.CapExceeded.selector);
        minter.mint(big, sigsBig);
        // With something already counted, used + amount would overflow if it were added before it was compared.
        _mintTo(address(1), 1, keccak256("b"));
        (ThresholdMinter.Mint memory bigger, bytes[] memory sigsBigger) = _signedMint(type(uint256).max, keccak256("c"));
        vm.expectRevert(ThresholdMinter.CapExceeded.selector);
        minter.mint(bigger, sigsBigger);
    }

    function test_mintingExactlyTheCapWorksAndOneMoreWeiDoesNot() public {
        address token = _list();
        _mintTo(address(1), CAP, keccak256("a"));
        (ThresholdMinter.Mint memory m, bytes[] memory sigs) = _signedMint(1, keccak256("b"));
        vm.expectRevert(ThresholdMinter.CapExceeded.selector);
        minter.mint(m, sigs);
        (, uint256 used,) = minter.caps(token);
        assertEq(used, CAP);
    }

    function test_capIsACalendarDayNotARollingWindow() public {
        _list();
        vm.warp(10 days + 23 hours + 59 minutes);
        _mintTo(address(1), CAP, keccak256("a"));
        (ThresholdMinter.Mint memory m, bytes[] memory sigs) = _signedMint(1, keccak256("b"));
        vm.expectRevert(ThresholdMinter.CapExceeded.selector);
        minter.mint(m, sigs);
        // Two minutes later it is midnight UTC: a new day, a fresh allowance.
        vm.warp(11 days);
        minter.mint(m, sigs);
        // Twenty-three hours into that day the same day's count is still running.
        vm.warp(11 days + 23 hours);
        _mintTo(address(1), CAP - 1, keccak256("c"));
        (ThresholdMinter.Mint memory n, bytes[] memory sigsN) = _signedMint(1, keccak256("d"));
        vm.expectRevert(ThresholdMinter.CapExceeded.selector);
        minter.mint(n, sigsN);
    }

    /// Any cap but UNCAPPED, any two amounts: a mint passes exactly when it fits in what is left of the day,
    /// a refused mint counts for nothing, and the count never passes the cap.
    function testFuzz_dailyCapAccounting(uint256 cap, uint256 a, uint256 b) public {
        cap = bound(cap, 0, type(uint256).max - 1);
        address token = _listCapped(cap);

        (ThresholdMinter.Mint memory first, bytes[] memory sigsFirst) = _signedMint(a, keccak256("a"));
        bool firstFits = a <= cap;
        if (!firstFits) vm.expectRevert(ThresholdMinter.CapExceeded.selector);
        minter.mint(first, sigsFirst);
        uint256 used = firstFits ? a : 0;

        (ThresholdMinter.Mint memory second, bytes[] memory sigsSecond) = _signedMint(b, keccak256("b"));
        bool secondFits = b <= cap - used;
        if (!secondFits) vm.expectRevert(ThresholdMinter.CapExceeded.selector);
        minter.mint(second, sigsSecond);
        if (secondFits) used += b;

        (uint256 perDay, uint256 counted,) = minter.caps(token);
        assertEq(perDay, cap);
        assertEq(counted, used);
        assertLe(counted, cap);
        assertEq(BridgeToken(token).totalSupply(), used);
        // A refused mint leaves its lock unspent, so it can still go through once the cap allows it.
        assertEq(minter.minted(keccak256("a")), firstFits);
        assertEq(minter.minted(keccak256("b")), secondFits);
    }

    // ------------------------------------------------------------ burning

    function test_burnEmitsDestination() public {
        address token = _list();
        ThresholdMinter.Mint memory m = ThresholdMinter.Mint({tokenId: TOKEN, to: address(this), amount: 50e18, srcTx: keccak256("l")});
        minter.mint(m, _sign(_mintDigest(m), _two()));
        vm.expectEmit(true, false, false, true, token);
        emit BridgeToken.Burn(address(this), 20e18, "r4eN64rUAJPWibBs2gvUmdfEoZMYiFqc9M", 1);
        uint256 nonce = BridgeToken(token).burn{value: FEE}(20e18, "r4eN64rUAJPWibBs2gvUmdfEoZMYiFqc9M");
        assertEq(nonce, 1);
        assertEq(BridgeToken(token).balanceOf(address(this)), 30e18);
        vm.expectRevert(BridgeToken.BadAddress.selector);
        BridgeToken(token).burn{value: FEE}(1, "not-an-address");
    }

    function test_burnRejectsZero() public {
        address token = _list();
        ThresholdMinter.Mint memory m = ThresholdMinter.Mint({tokenId: TOKEN, to: address(this), amount: 5e18, srcTx: keccak256("z")});
        minter.mint(m, _sign(_mintDigest(m), _two()));
        vm.expectRevert(BridgeToken.BadAmount.selector);
        BridgeToken(token).burn{value: FEE}(0, "r4eN64rUAJPWibBs2gvUmdfEoZMYiFqc9M");
        assertEq(BridgeToken(token).burnCount(), 0);
    }

    // ------------------------------------------------------------ rotation

    function test_rotationWaitsForDelay() public {
        ThresholdMinter.Rotation memory r = _rotation(_nextSet(), 0, 0);
        minter.proposeRotation(r, _sign(_rotateDigest(r), _two()));
        assertEq(minter.proposalSeq(), 1);
        vm.expectRevert(ThresholdMinter.RotationNotReady.selector);
        minter.executeRotation();
        vm.warp(block.timestamp + 1 days);
        minter.executeRotation();
        assertTrue(minter.isSigner(address(0x1111)));
        assertFalse(minter.isSigner(signers[0]));
        assertEq(minter.rotationNonce(), 1);
    }

    function test_rotationReplacesTheSignerSetAndThreshold() public {
        _list();
        (uint256[] memory nks, address[] memory next) = _sortedSet(0x7000, 3);
        ThresholdMinter.Rotation memory r = ThresholdMinter.Rotation({signers: next, threshold: 3, nonce: 0, seq: 0});
        minter.proposeRotation(r, _sign(_rotateDigest(r), _two()));
        vm.warp(block.timestamp + 1 days);
        minter.executeRotation();
        assertEq(minter.threshold(), 3);
        address[] memory now_ = minter.signers();
        assertEq(now_.length, 3);
        for (uint256 i = 0; i < 3; i++) {
            assertEq(now_[i], next[i]);
            assertTrue(minter.isSigner(next[i]));
            assertFalse(minter.isSigner(signers[i]));
        }
        ThresholdMinter.Mint memory m = ThresholdMinter.Mint({tokenId: TOKEN, to: address(1), amount: 1, srcTx: keccak256("x")});
        bytes32 digest = _mintDigest(m);
        // The old set no longer counts, even with enough of them.
        bytes[] memory oldSigs = _sign(digest, _three());
        vm.expectRevert(ThresholdMinter.BadSignature.selector);
        minter.mint(m, oldSigs);
        // The new threshold is 3: two of the new set are not enough.
        bytes[] memory twoNew = _signWith(nks, 2, digest);
        vm.expectRevert(ThresholdMinter.NotEnoughSignatures.selector);
        minter.mint(m, twoNew);
        minter.mint(m, _signWith(nks, 3, digest));
        assertTrue(minter.minted(keccak256("x")));
    }

    function test_proposeRotationRejectsABadSet() public {
        address[] memory zero = new address[](2);
        zero[0] = address(0x1111);
        address[] memory dup = new address[](2);
        dup[0] = address(0x1111);
        dup[1] = address(0x1111);
        address[] memory none = new address[](0);
        ThresholdMinter.Rotation memory withZero = _rotation(zero, 0, 0);
        bytes[] memory sigsZero = _sign(_rotateDigest(withZero), _two());
        vm.expectRevert(ThresholdMinter.BadSignerSet.selector);
        minter.proposeRotation(withZero, sigsZero);
        ThresholdMinter.Rotation memory withDup = _rotation(dup, 0, 0);
        bytes[] memory sigsDup = _sign(_rotateDigest(withDup), _two());
        vm.expectRevert(ThresholdMinter.BadSignerSet.selector);
        minter.proposeRotation(withDup, sigsDup);
        ThresholdMinter.Rotation memory empty = _rotation(none, 0, 0);
        bytes[] memory sigsEmpty = _sign(_rotateDigest(empty), _two());
        vm.expectRevert(ThresholdMinter.BadSignerSet.selector);
        minter.proposeRotation(empty, sigsEmpty);
        // k above n.
        ThresholdMinter.Rotation memory tooHigh = ThresholdMinter.Rotation({signers: _nextSet(), threshold: 3, nonce: 0, seq: 0});
        bytes[] memory sigsHigh = _sign(_rotateDigest(tooHigh), _two());
        vm.expectRevert(ThresholdMinter.BadSignerSet.selector);
        minter.proposeRotation(tooHigh, sigsHigh);
        assertEq(minter.pendingRotation(), bytes32(0));
    }

    function test_proposeRotationRejectsAWrongNonce() public {
        ThresholdMinter.Rotation memory r = _rotation(_nextSet(), 1, 0);
        bytes[] memory sigs = _sign(_rotateDigest(r), _two());
        vm.expectRevert(ThresholdMinter.BadNonce.selector);
        minter.proposeRotation(r, sigs);
    }

    function test_proposeRotationRejectsOneSignature() public {
        ThresholdMinter.Rotation memory r = _rotation(_nextSet(), 0, 0);
        bytes[] memory sigs = _one(_rotateDigest(r));
        vm.expectRevert(ThresholdMinter.NotEnoughSignatures.selector);
        minter.proposeRotation(r, sigs);
    }

    function test_executeRotationNeedsAProposal() public {
        vm.expectRevert(ThresholdMinter.NoPendingRotation.selector);
        minter.executeRotation();
    }

    function test_rotationProposalCannotBeReplayed() public {
        ThresholdMinter.Rotation memory r = _rotation(_nextSet(), 0, 0);
        bytes[] memory sigs = _sign(_rotateDigest(r), _two());
        minter.proposeRotation(r, sigs);
        uint256 readyAt = minter.pendingRotationAt();
        vm.warp(block.timestamp + 12 hours);
        // Same calldata again: the seq moved on, so the delay cannot be reset.
        vm.expectRevert(ThresholdMinter.BadSeq.selector);
        minter.proposeRotation(r, sigs);
        // Even a message that claims the new seq needs fresh signatures.
        ThresholdMinter.Rotation memory again = _rotation(_nextSet(), 0, 1);
        vm.expectRevert(ThresholdMinter.BadSignature.selector);
        minter.proposeRotation(again, sigs);
        assertEq(minter.pendingRotationAt(), readyAt);
    }

    function test_cancelCannotBeReplayed() public {
        ThresholdMinter.Rotation memory r = _rotation(_nextSet(), 0, 0);
        minter.proposeRotation(r, _sign(_rotateDigest(r), _two()));
        bytes32 rotation = minter.pendingRotation();
        bytes[] memory cancel = _sign(_cancelDigest(rotation, 1), _two());
        minter.cancelRotation(cancel);
        assertEq(minter.pendingRotation(), bytes32(0));
        assertEq(minter.proposalSeq(), 2);
        vm.expectRevert(ThresholdMinter.NoPendingRotation.selector);
        minter.cancelRotation(cancel);
        // The same rotation proposed again (seq 2) is a new proposal: the old cancel does not touch it.
        ThresholdMinter.Rotation memory r2 = _rotation(_nextSet(), 0, 2);
        minter.proposeRotation(r2, _sign(_rotateDigest(r2), _two()));
        vm.expectRevert(ThresholdMinter.BadSignature.selector);
        minter.cancelRotation(cancel);
        assertEq(minter.proposalSeq(), 3);
        // A cancel signed for a different pending rotation is refused too.
        bytes[] memory wrongRotation = _sign(_cancelDigest(keccak256("other"), 3), _two());
        vm.expectRevert(ThresholdMinter.BadSignature.selector);
        minter.cancelRotation(wrongRotation);
        // The right one works exactly once.
        minter.cancelRotation(_sign(_cancelDigest(minter.pendingRotation(), 3), _two()));
        assertEq(minter.pendingRotation(), bytes32(0));
    }

    // ------------------------------------------------------------ metadata

    function test_listCarriesMetadata() public {
        ThresholdMinter.Listing memory l = _listing("Petal", "PETAL", IMAGE);
        bytes[] memory sigs = _sign(_listDigest(l), _two());
        address factory = address(minter.factory());
        address expected = vm.computeCreateAddress(factory, vm.getNonce(factory));
        vm.expectEmit(true, false, false, true, factory);
        emit TokenFactory.Deployed(expected, "Petal", "PETAL", IMAGE);
        vm.expectEmit(true, true, false, true, address(minter));
        emit ThresholdMinter.Listed(TOKEN, expected, "Petal", "PETAL", IMAGE, 1000e18);
        address token = minter.listToken(l, sigs);
        assertEq(token, expected);
        assertEq(BridgeToken(token).name(), "Petal");
        assertEq(BridgeToken(token).symbol(), "PETAL");
        assertEq(BridgeToken(token).imageURI(), IMAGE);
        assertEq(minter.metaNonce(TOKEN), 0);
    }

    function test_updateTokenChangesMetadata() public {
        address token = _list();
        ThresholdMinter.Update memory u = _update("Petal Two", "PTL2", IMAGE_2, 1000e18, 1);
        bytes[] memory sigs = _sign(_updateDigest(u), _two());
        vm.expectEmit(false, false, false, true, token);
        emit BridgeToken.MetadataUpdated("Petal Two", "PTL2", IMAGE_2);
        vm.expectEmit(true, true, false, true, address(minter));
        emit ThresholdMinter.Updated(TOKEN, token, "Petal Two", "PTL2", IMAGE_2, 1000e18, 1);
        minter.updateToken(u, sigs);
        assertEq(BridgeToken(token).name(), "Petal Two");
        assertEq(BridgeToken(token).symbol(), "PTL2");
        assertEq(BridgeToken(token).imageURI(), IMAGE_2);
        assertEq(minter.metaNonce(TOKEN), 1);
    }

    function test_updateTokenRaisesCapWithinTheDay() public {
        address token = _list(); // 1000 a day
        (ThresholdMinter.Mint memory a, bytes[] memory sigsA) = _signedMint(900e18, keccak256("a"));
        minter.mint(a, sigsA);
        (ThresholdMinter.Mint memory b, bytes[] memory sigsB) = _signedMint(200e18, keccak256("b"));
        vm.expectRevert(ThresholdMinter.CapExceeded.selector);
        minter.mint(b, sigsB);
        ThresholdMinter.Update memory u = _update("Petal", "PETAL", IMAGE, 2000e18, 1);
        minter.updateToken(u, _sign(_updateDigest(u), _two()));
        // Same UTC day: the 900 already minted still counts, and 1100 fits under 2000.
        minter.mint(b, sigsB);
        (uint256 perDay, uint256 used,) = minter.caps(token);
        assertEq(perDay, 2000e18);
        assertEq(used, 1100e18);
    }

    function test_updateTokenLowersCapWithinTheDay() public {
        _list(); // 1000 a day
        (ThresholdMinter.Mint memory a, bytes[] memory sigsA) = _signedMint(100e18, keccak256("a"));
        minter.mint(a, sigsA);
        // 100 + 300 fits the old cap of 1000.
        (ThresholdMinter.Mint memory c, bytes[] memory sigsC) = _signedMint(300e18, keccak256("c"));
        ThresholdMinter.Update memory u = _update("Petal", "PETAL", IMAGE, 300e18, 1);
        minter.updateToken(u, _sign(_updateDigest(u), _two()));
        vm.expectRevert(ThresholdMinter.CapExceeded.selector);
        minter.mint(c, sigsC);
        // A new UTC day starts from zero under the new cap.
        vm.warp(block.timestamp + 1 days);
        minter.mint(c, sigsC);
    }

    function test_updateTokenCannotBeReplayed() public {
        _list();
        ThresholdMinter.Update memory u = _update("Petal Two", "PTL2", IMAGE_2, 1000e18, 1);
        bytes[] memory sigs = _sign(_updateDigest(u), _two());
        minter.updateToken(u, sigs);
        vm.expectRevert(ThresholdMinter.BadNonce.selector);
        minter.updateToken(u, sigs);
    }

    function test_updateTokenNoncesRunInOrder() public {
        address token = _list();
        ThresholdMinter.Update memory first = _update("Petal Two", "PTL2", IMAGE_2, 1000e18, 1);
        ThresholdMinter.Update memory second = _update("Petal Three", "PTL3", IMAGE, 500e18, 2);
        bytes[] memory sigsFirst = _sign(_updateDigest(first), _two());
        bytes[] memory sigsSecond = _sign(_updateDigest(second), _two());
        // Nonce 2 cannot jump ahead of nonce 1.
        vm.expectRevert(ThresholdMinter.BadNonce.selector);
        minter.updateToken(second, sigsSecond);
        minter.updateToken(first, sigsFirst);
        minter.updateToken(second, sigsSecond);
        // The older update can never roll the newer one back.
        vm.expectRevert(ThresholdMinter.BadNonce.selector);
        minter.updateToken(first, sigsFirst);
        assertEq(BridgeToken(token).name(), "Petal Three");
        assertEq(minter.metaNonce(TOKEN), 2);
    }

    function test_updateTokenRejectsUnknownToken() public {
        ThresholdMinter.Update memory u = _update("Petal", "PETAL", IMAGE, 1000e18, 1);
        bytes[] memory sigs = _sign(_updateDigest(u), _two());
        vm.expectRevert(ThresholdMinter.UnknownToken.selector);
        minter.updateToken(u, sigs);
    }

    function test_updateTokenRejectsSignaturesOverAnotherNonce() public {
        _list();
        // Signed for nonce 2, submitted as nonce 1.
        bytes[] memory sigs = _sign(_updateDigest(_update("Petal Two", "PTL2", IMAGE_2, 1000e18, 2)), _two());
        ThresholdMinter.Update memory u = _update("Petal Two", "PTL2", IMAGE_2, 1000e18, 1);
        vm.expectRevert(ThresholdMinter.BadSignature.selector);
        minter.updateToken(u, sigs);
    }

    function test_updateTokenRejectsOutsider() public {
        _list();
        ThresholdMinter.Update memory u = _update("Petal Two", "PTL2", IMAGE_2, 1000e18, 1);
        bytes[] memory sigs = _withOutsider(_updateDigest(u));
        vm.expectRevert(ThresholdMinter.BadSignature.selector);
        minter.updateToken(u, sigs);
    }

    function test_updateTokenRejectsOneSignature() public {
        _list();
        ThresholdMinter.Update memory u = _update("Petal Two", "PTL2", IMAGE_2, 1000e18, 1);
        bytes[] memory sigs = _one(_updateDigest(u));
        vm.expectRevert(ThresholdMinter.NotEnoughSignatures.selector);
        minter.updateToken(u, sigs);
    }

    function test_setMetadataOnlyMinter() public {
        address token = _list();
        vm.expectRevert(BridgeToken.NotMinter.selector);
        BridgeToken(token).setMetadata("Evil", "EVIL", "");
        // Not an operator key on its own either.
        vm.prank(signers[0]);
        vm.expectRevert(BridgeToken.NotMinter.selector);
        BridgeToken(token).setMetadata("Evil", "EVIL", "");
        assertEq(BridgeToken(token).name(), "Petal");
    }

    function test_mintOnlyMinter() public {
        address token = _list();
        vm.expectRevert(BridgeToken.NotMinter.selector);
        BridgeToken(token).mint(address(this), 1);
        vm.prank(signers[0]);
        vm.expectRevert(BridgeToken.NotMinter.selector);
        BridgeToken(token).mint(address(this), 1);
        assertEq(BridgeToken(token).totalSupply(), 0);
    }

    function test_factoryDeploysOnlyForTheMinter() public {
        TokenFactory factory = minter.factory();
        vm.expectRevert(TokenFactory.NotMinter.selector);
        factory.deploy("Evil", "EVIL", "");
    }

    /// Valid signatures over a listing that breaks a length bound are still refused,
    /// and with no signatures at all the bound is what refuses it: it runs before signature checks.
    function _expectListRejected(string memory name_, string memory symbol_, string memory imageURI_) internal {
        ThresholdMinter.Listing memory l = _listing(name_, symbol_, imageURI_);
        bytes[] memory sigs = _sign(_listDigest(l), _two());
        vm.expectRevert(ThresholdMinter.BadMetadata.selector);
        minter.listToken(l, sigs);
        vm.expectRevert(ThresholdMinter.BadMetadata.selector);
        minter.listToken(l, new bytes[](0));
    }

    function _expectUpdateRejected(string memory name_, string memory symbol_, string memory imageURI_) internal {
        ThresholdMinter.Update memory u = _update(name_, symbol_, imageURI_, 1000e18, minter.metaNonce(TOKEN) + 1);
        bytes[] memory sigs = _sign(_updateDigest(u), _two());
        vm.expectRevert(ThresholdMinter.BadMetadata.selector);
        minter.updateToken(u, sigs);
        vm.expectRevert(ThresholdMinter.BadMetadata.selector);
        minter.updateToken(u, new bytes[](0));
    }

    function test_listTokenRejectsBadMetadata() public {
        _expectListRejected("", "PETAL", IMAGE);
        _expectListRejected(_ofLength(65), "PETAL", IMAGE);
        _expectListRejected("Petal", "", IMAGE);
        _expectListRejected("Petal", _ofLength(33), IMAGE);
        _expectListRejected("Petal", "PETAL", _ofLength(257));
        assertEq(minter.tokens(TOKEN), address(0));
    }

    function test_updateTokenRejectsBadMetadata() public {
        address token = _list();
        _expectUpdateRejected("", "PETAL", IMAGE);
        _expectUpdateRejected(_ofLength(65), "PETAL", IMAGE);
        _expectUpdateRejected("Petal", "", IMAGE);
        _expectUpdateRejected("Petal", _ofLength(33), IMAGE);
        _expectUpdateRejected("Petal", "PETAL", _ofLength(257));
        assertEq(minter.metaNonce(TOKEN), 0);
        assertEq(BridgeToken(token).name(), "Petal");
    }

    function test_metadataBoundsAreInclusive() public {
        ThresholdMinter.Listing memory l = _listing(_ofLength(64), _ofLength(32), _ofLength(256));
        address token = minter.listToken(l, _sign(_listDigest(l), _two()));
        assertEq(BridgeToken(token).imageURI(), _ofLength(256));
        // An empty logo is allowed.
        ThresholdMinter.Update memory u = _update(_ofLength(64), _ofLength(32), "", 1000e18, 1);
        minter.updateToken(u, _sign(_updateDigest(u), _two()));
        assertEq(BridgeToken(token).name(), _ofLength(64));
        assertEq(BridgeToken(token).symbol(), _ofLength(32));
        assertEq(BridgeToken(token).imageURI(), "");
    }
}
