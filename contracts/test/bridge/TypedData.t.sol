// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {BridgeBase} from "./BridgeBase.sol";
import {ThresholdMinter} from "../../src/bridge/ThresholdMinter.sol";
import {BridgeToken} from "../../src/bridge/BridgeToken.sol";

/// OpenZeppelin's EIP712 with the minter's name and version: the component the minter's own domain replaced.
contract ReferenceDomain is EIP712 {
    constructor() EIP712("BlumeBridge", "3") {}

    function separator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function digest(bytes32 structHash) external view returns (bytes32) {
        return _hashTypedDataV4(structHash);
    }
}

/// The signed messages, checked against the standard rather than against the contract's own hashing: the typehash
/// strings as the spec writes them, digests built from eth_signTypedData_v4 JSON (what viem's hashTypedData computes)
/// with the cheatcode `vm.eip712HashTypedData`, and the ways a signature must not travel (another minter, another
/// chain, an older version).
contract TypedDataTest is BridgeBase {
    bytes32 constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    // ------------------------------------------------------------ the spec strings

    function test_typehashesMatchTheSpecStrings() public view {
        assertEq(minter.MINT_TYPEHASH(), keccak256("Mint(bytes32 tokenId,address to,uint256 amount,bytes32 srcTx)"));
        assertEq(minter.LIST_TYPEHASH(), keccak256("List(bytes32 tokenId,string name,string symbol,string imageURI,uint256 dailyCap)"));
        assertEq(minter.UPDATE_TYPEHASH(), keccak256("Update(bytes32 tokenId,string name,string symbol,string imageURI,uint256 dailyCap,uint256 nonce)"));
        assertEq(minter.ROTATE_TYPEHASH(), keccak256("Rotate(address[] signers,uint8 threshold,uint256 nonce,uint256 seq)"));
        assertEq(minter.CANCEL_TYPEHASH(), keccak256("Cancel(bytes32 rotation,uint256 seq)"));
        assertEq(minter.SET_BURN_FEE_TYPEHASH(), keccak256("SetBurnFee(uint256 burnFee,uint256 nonce)"));
        assertEq(minter.SWEEP_TYPEHASH(), keccak256("Sweep(address[] to,uint256[] amounts,uint256 nonce)"));
        assertEq(minter.RESUME_TYPEHASH(), keccak256("Resume(uint256 nonce)"));
    }

    function _separator(uint256 chainId, address verifyingContract) internal pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("BlumeBridge"), keccak256("3"), chainId, verifyingContract));
    }

    function test_domainIsBlumeBridgeVersionThree() public view {
        (bytes1 fields, string memory name_, string memory version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] memory extensions) =
            minter.eip712Domain();
        // ERC-5267: bits 0 to 3 are set (name, version, chain id, verifying contract); there is no salt and no extension.
        assertEq(fields, hex"0f");
        assertEq(name_, "BlumeBridge");
        assertEq(version, "3");
        assertEq(chainId, block.chainid);
        assertEq(verifyingContract, address(minter));
        assertEq(salt, bytes32(0));
        assertEq(extensions.length, 0);
        assertEq(minter.domainSeparator(), _separator(block.chainid, address(minter)));
    }

    function test_theDomainSeparatorFollowsTheChainItIsOn() public {
        // vm.getChainId, not block.chainid: the optimizer may move a plain chainid read across the cheatcode call below.
        uint256 here = vm.getChainId();
        bytes32 before = minter.domainSeparator();
        vm.chainId(1440000);
        assertEq(minter.domainSeparator(), _separator(1440000, address(minter)));
        (,,, uint256 chainId,,,) = minter.eip712Domain();
        assertEq(chainId, 1440000);
        vm.chainId(here);
        assertEq(minter.domainSeparator(), before);
    }

    /// The hand-written domain is the one OpenZeppelin's EIP712 builds for the same name, version, chain and address,
    /// and the digest wraps a struct hash the same way, on this chain and after the chain id changes.
    function test_theDomainMatchesOpenZeppelinsForTheSameAddress() public {
        ReferenceDomain oz = new ReferenceDomain();
        bytes32 structHash = keccak256("any struct hash");
        uint256 here = vm.getChainId(); // not block.chainid: see the test above
        assertEq(oz.separator(), _separator(here, address(oz)));
        assertEq(oz.digest(structHash), keccak256(abi.encodePacked("\x19\x01", _separator(here, address(oz)), structHash)));
        vm.chainId(1440000);
        assertEq(oz.separator(), _separator(1440000, address(oz)));
        assertEq(minter.domainSeparator(), _separator(1440000, address(minter)));
    }

    // ------------------------------------------------------------ digests built from JSON

    /// Digest of an eth_signTypedData_v4 JSON payload (what viem's hashTypedData computes) under the minter's domain.
    function _typedDataDigest(string memory primaryType, string memory fields, string memory message) internal view returns (bytes32) {
        string memory json = string.concat(
            '{"types":{"EIP712Domain":[{"name":"name","type":"string"},{"name":"version","type":"string"},',
            '{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}],"',
            primaryType,
            '":',
            fields,
            '},"primaryType":"',
            primaryType,
            '","domain":{"name":"BlumeBridge","version":"3","chainId":',
            vm.toString(block.chainid),
            ',"verifyingContract":"',
            vm.toString(address(minter)),
            '"},"message":',
            message,
            "}"
        );
        return vm.eip712HashTypedData(json);
    }

    /// Signatures over standard EIP-712 typed data, built independently of the contract's struct hashing, list and update a token.
    function test_typedDataJsonSignaturesVerify() public {
        bytes32 listDigest = _typedDataDigest(
            "List",
            '[{"name":"tokenId","type":"bytes32"},{"name":"name","type":"string"},{"name":"symbol","type":"string"},{"name":"imageURI","type":"string"},{"name":"dailyCap","type":"uint256"}]',
            string.concat('{"tokenId":"', vm.toString(TOKEN), '","name":"Petal","symbol":"PETAL","imageURI":"', IMAGE, '","dailyCap":"1000000000000000000000"}')
        );
        ThresholdMinter.Listing memory l = _listing("Petal", "PETAL", IMAGE);
        assertEq(listDigest, _listDigest(l));
        address token = minter.listToken(l, _sign(listDigest, _two()));

        bytes32 updateDigest = _typedDataDigest(
            "Update",
            '[{"name":"tokenId","type":"bytes32"},{"name":"name","type":"string"},{"name":"symbol","type":"string"},{"name":"imageURI","type":"string"},{"name":"dailyCap","type":"uint256"},{"name":"nonce","type":"uint256"}]',
            string.concat('{"tokenId":"', vm.toString(TOKEN), '","name":"Petal Two","symbol":"PTL2","imageURI":"', IMAGE_2, '","dailyCap":"2000000000000000000000","nonce":"1"}')
        );
        ThresholdMinter.Update memory u = _update("Petal Two", "PTL2", IMAGE_2, 2000e18, 1);
        assertEq(updateDigest, _updateDigest(u));
        minter.updateToken(u, _sign(updateDigest, _two()));
        assertEq(BridgeToken(token).symbol(), "PTL2");
    }

    function test_typedDataJsonMint() public {
        address token = _list();
        ThresholdMinter.Mint memory m = ThresholdMinter.Mint({tokenId: TOKEN, to: address(0xBEEF), amount: 100e18, srcTx: keccak256("lock1")});
        bytes32 digest = _typedDataDigest(
            "Mint",
            '[{"name":"tokenId","type":"bytes32"},{"name":"to","type":"address"},{"name":"amount","type":"uint256"},{"name":"srcTx","type":"bytes32"}]',
            string.concat(
                '{"tokenId":"',
                vm.toString(TOKEN),
                '","to":"',
                vm.toString(address(0xBEEF)),
                '","amount":"100000000000000000000","srcTx":"',
                vm.toString(keccak256("lock1")),
                '"}'
            )
        );
        assertEq(digest, _mintDigest(m));
        minter.mint(m, _sign(digest, _two()));
        assertEq(BridgeToken(token).balanceOf(address(0xBEEF)), 100e18);
    }

    function test_typedDataJsonRotate() public {
        address[] memory next = _nextSet();
        ThresholdMinter.Rotation memory r = _rotation(next, 0, 0);
        bytes32 digest = _typedDataDigest(
            "Rotate",
            '[{"name":"signers","type":"address[]"},{"name":"threshold","type":"uint8"},{"name":"nonce","type":"uint256"},{"name":"seq","type":"uint256"}]',
            string.concat('{"signers":["', vm.toString(next[0]), '","', vm.toString(next[1]), '"],"threshold":"2","nonce":"0","seq":"0"}')
        );
        assertEq(digest, _rotateDigest(r));
        minter.proposeRotation(r, _sign(digest, _two()));
        assertTrue(minter.pendingRotation() != bytes32(0));
        vm.warp(block.timestamp + 1 days);
        minter.executeRotation();
        assertTrue(minter.isSigner(next[0]));
        assertTrue(minter.isSigner(next[1]));
        assertFalse(minter.isSigner(signers[0]));
    }

    function test_typedDataJsonCancel() public {
        ThresholdMinter.Rotation memory r = _rotation(_nextSet(), 0, 0);
        minter.proposeRotation(r, _sign(_rotateDigest(r), _two()));
        bytes32 rotation = minter.pendingRotation();
        bytes32 digest = _typedDataDigest(
            "Cancel", '[{"name":"rotation","type":"bytes32"},{"name":"seq","type":"uint256"}]', string.concat('{"rotation":"', vm.toString(rotation), '","seq":"1"}')
        );
        assertEq(digest, _cancelDigest(rotation, 1));
        minter.cancelRotation(_sign(digest, _two()));
        assertEq(minter.pendingRotation(), bytes32(0));
        assertEq(minter.proposalSeq(), 2);
    }

    function test_typedDataJsonSetBurnFee() public {
        ThresholdMinter.Fee memory f = ThresholdMinter.Fee({burnFee: 0.5 ether, nonce: 0});
        bytes32 digest = _typedDataDigest(
            "SetBurnFee", '[{"name":"burnFee","type":"uint256"},{"name":"nonce","type":"uint256"}]', '{"burnFee":"500000000000000000","nonce":"0"}'
        );
        assertEq(digest, _feeDigest(f));
        minter.setBurnFee(f, _sign(digest, _two()));
        assertEq(minter.burnFee(), 0.5 ether);
        assertEq(minter.feeNonce(), 1);
    }

    function test_typedDataJsonSweep() public {
        vm.deal(address(minter), 3 ether);
        address a = makeAddr("operator");
        address b = makeAddr("treasury");
        (address[] memory to, uint256[] memory amounts) = _pay(a, 1 ether);
        to = _append(to, b);
        amounts = _append(amounts, 2 ether);
        ThresholdMinter.Sweep memory s = ThresholdMinter.Sweep({to: to, amounts: amounts, nonce: 0});
        bytes32 digest = _typedDataDigest(
            "Sweep",
            '[{"name":"to","type":"address[]"},{"name":"amounts","type":"uint256[]"},{"name":"nonce","type":"uint256"}]',
            string.concat('{"to":["', vm.toString(a), '","', vm.toString(b), '"],"amounts":["1000000000000000000","2000000000000000000"],"nonce":"0"}')
        );
        assertEq(digest, _sweepDigest(s));
        minter.sweep(s, _sign(digest, _two()));
        assertEq(a.balance, 1 ether);
        assertEq(b.balance, 2 ether);
        assertEq(minter.sweepNonce(), 1);
    }

    function test_typedDataJsonResume() public {
        _pauseBy(0);
        bytes32 digest = _typedDataDigest("Resume", '[{"name":"nonce","type":"uint256"}]', '{"nonce":"0"}');
        assertEq(digest, _resumeDigest(0));
        minter.resume(0, _sign(digest, _two()));
        assertFalse(minter.paused());
        assertEq(minter.resumeNonce(), 1);
    }

    function _append(address[] memory xs, address x) internal pure returns (address[] memory out) {
        out = new address[](xs.length + 1);
        for (uint256 i = 0; i < xs.length; i++) out[i] = xs[i];
        out[xs.length] = x;
    }

    function _append(uint256[] memory xs, uint256 x) internal pure returns (uint256[] memory out) {
        out = new uint256[](xs.length + 1);
        for (uint256 i = 0; i < xs.length; i++) out[i] = xs[i];
        out[xs.length] = x;
    }

    // ------------------------------------------------------------ signatures do not travel

    /// Same signers, same chain, a different `verifyingContract`: nothing signed for `minter` is good on `other`.
    function _other() internal returns (ThresholdMinter other) {
        other = new ThresholdMinter(signers, 2, 1 days, FEE);
        assertTrue(address(other) != address(minter));
        assertTrue(other.domainSeparator() != minter.domainSeparator());
    }

    function test_listSignedForAnotherMinterIsRefused() public {
        ThresholdMinter other = _other();
        ThresholdMinter.Listing memory l = _listing("Petal", "PETAL", IMAGE);
        bytes[] memory forMinter = _sign(_listDigest(l), _two());
        vm.expectRevert(ThresholdMinter.BadSignature.selector);
        other.listToken(l, forMinter);
        minter.listToken(l, forMinter);
        other.listToken(l, _sign(_digestFor(other, _listHash(l)), _two()));
    }

    function test_mintSignedForAnotherMinterIsRefused() public {
        ThresholdMinter other = _other();
        _list();
        ThresholdMinter.Listing memory l = _listing("Petal", "PETAL", IMAGE);
        other.listToken(l, _sign(_digestFor(other, _listHash(l)), _two()));
        ThresholdMinter.Mint memory m = ThresholdMinter.Mint({tokenId: TOKEN, to: address(1), amount: 10, srcTx: keccak256("x")});
        bytes[] memory forMinter = _sign(_mintDigest(m), _two());
        vm.expectRevert(ThresholdMinter.BadSignature.selector);
        other.mint(m, forMinter);
        assertFalse(other.minted(keccak256("x")));
        minter.mint(m, forMinter);
        assertTrue(minter.minted(keccak256("x")));
    }

    function test_updateSignedForAnotherMinterIsRefused() public {
        ThresholdMinter other = _other();
        _list();
        ThresholdMinter.Listing memory l = _listing("Petal", "PETAL", IMAGE);
        other.listToken(l, _sign(_digestFor(other, _listHash(l)), _two()));
        ThresholdMinter.Update memory u = _update("Petal Two", "PTL2", IMAGE_2, 5, 1);
        bytes[] memory forMinter = _sign(_updateDigest(u), _two());
        vm.expectRevert(ThresholdMinter.BadSignature.selector);
        other.updateToken(u, forMinter);
        minter.updateToken(u, forMinter);
    }

    function test_rotationSignedForAnotherMinterIsRefused() public {
        ThresholdMinter other = _other();
        ThresholdMinter.Rotation memory r = _rotation(_nextSet(), 0, 0);
        bytes[] memory forMinter = _sign(_rotateDigest(r), _two());
        vm.expectRevert(ThresholdMinter.BadSignature.selector);
        other.proposeRotation(r, forMinter);
        minter.proposeRotation(r, forMinter);
        // Both now hold the same pending rotation, so a cancel signed for one is the same message with another domain.
        other.proposeRotation(r, _sign(_digestFor(other, _rotateHash(r)), _two()));
        assertEq(other.pendingRotation(), minter.pendingRotation());
        bytes[] memory cancelForMinter = _sign(_cancelDigest(minter.pendingRotation(), 1), _two());
        vm.expectRevert(ThresholdMinter.BadSignature.selector);
        other.cancelRotation(cancelForMinter);
        minter.cancelRotation(cancelForMinter);
    }

    function test_feeChangeSignedForAnotherMinterIsRefused() public {
        ThresholdMinter other = _other();
        ThresholdMinter.Fee memory f = ThresholdMinter.Fee({burnFee: 0.5 ether, nonce: 0});
        bytes[] memory forMinter = _sign(_feeDigest(f), _two());
        vm.expectRevert(ThresholdMinter.BadSignature.selector);
        other.setBurnFee(f, forMinter);
        assertEq(other.burnFee(), FEE);
        minter.setBurnFee(f, forMinter);
        assertEq(minter.burnFee(), 0.5 ether);
    }

    function test_sweepSignedForAnotherMinterIsRefused() public {
        ThresholdMinter other = _other();
        vm.deal(address(minter), 1 ether);
        vm.deal(address(other), 1 ether);
        address operator = makeAddr("operator");
        (address[] memory to, uint256[] memory amounts) = _pay(operator, 1 ether);
        (ThresholdMinter.Sweep memory s, bytes[] memory forMinter) = _signedSweep(to, amounts);
        vm.expectRevert(ThresholdMinter.BadSignature.selector);
        other.sweep(s, forMinter);
        assertEq(address(other).balance, 1 ether);
        minter.sweep(s, forMinter);
        assertEq(operator.balance, 1 ether);
    }

    function test_resumeSignedForAnotherMinterIsRefused() public {
        ThresholdMinter other = _other();
        _pauseBy(0);
        vm.prank(signers[0]);
        other.pause();
        bytes[] memory forMinter = _sign(_resumeDigest(0), _two());
        vm.expectRevert(ThresholdMinter.BadSignature.selector);
        other.resume(0, forMinter);
        assertTrue(other.paused());
        minter.resume(0, forMinter);
        assertFalse(minter.paused());
    }

    function test_signatureForAnotherChainIsRefused() public {
        _list();
        ThresholdMinter.Mint memory m = ThresholdMinter.Mint({tokenId: TOKEN, to: address(1), amount: 10, srcTx: keccak256("x")});
        bytes[] memory forThisChain = _sign(_mintDigest(m), _two());
        bytes32 before = minter.domainSeparator();
        // A fork of the chain, or another chain where the same address holds the same code: same signers, different chain id.
        vm.chainId(block.chainid + 1);
        assertTrue(minter.domainSeparator() != before);
        vm.expectRevert(ThresholdMinter.BadSignature.selector);
        minter.mint(m, forThisChain);
        // Signed for the chain it is on, it works.
        minter.mint(m, _sign(_mintDigest(m), _two()));
        assertTrue(minter.minted(keccak256("x")));
    }

    function test_signatureFromTheVersionTwoDomainIsRefused() public {
        _list();
        ThresholdMinter.Mint memory m = ThresholdMinter.Mint({tokenId: TOKEN, to: address(1), amount: 10, srcTx: keccak256("x")});
        // The v2 domain: same name, chain and address, version "2". The messages did not change; the domain is what retires them.
        bytes32 v2Separator = keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("BlumeBridge"), keccak256("2"), block.chainid, address(minter)));
        bytes32 v2Digest = keccak256(abi.encodePacked("\x19\x01", v2Separator, _mintHash(m)));
        bytes[] memory sigs = _sign(v2Digest, _two());
        vm.expectRevert(ThresholdMinter.BadSignature.selector);
        minter.mint(m, sigs);
        minter.mint(m, _sign(_mintDigest(m), _two()));
    }

    /// Each message type has its own typehash, so a signature over one never passes for another that happens to share field values.
    function test_signatureForOneMessageTypeIsRefusedForAnother() public {
        // Resume(0) carries one number, SetBurnFee(0, 0) two, Sweep three fields: all of them zeroes here.
        _pauseBy(0);
        ThresholdMinter.Fee memory f = ThresholdMinter.Fee({burnFee: 0, nonce: 0});
        bytes[] memory feeSigs = _sign(_feeDigest(f), _two());
        vm.expectRevert(ThresholdMinter.BadSignature.selector);
        minter.resume(0, feeSigs);
        bytes[] memory resumeSigs = _sign(_resumeDigest(0), _two());
        vm.expectRevert(ThresholdMinter.BadSignature.selector);
        minter.setBurnFee(f, resumeSigs);
    }
}
