// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {BridgeBase} from "./BridgeBase.sol";
import {ThresholdMinter} from "../../src/bridge/ThresholdMinter.sol";
import {BridgeToken} from "../../src/bridge/BridgeToken.sol";

/// What a holder sends to leave: the destination the contract accepts, the Burn event the cluster decodes, and the
/// order of the checks.
contract BridgeTokenTest is BridgeBase {
    BridgeToken token;

    function setUp() public override {
        super.setUp();
        token = BridgeToken(_listCapped(type(uint256).max));
        _mintTo(address(this), 1_000_000e18, keccak256("lock-0"));
    }

    function _filled(uint256 length, bytes1 first) internal pure returns (string memory) {
        bytes memory b = new bytes(length);
        for (uint256 i = 0; i < length; i++) b[i] = "a";
        if (length > 0) b[0] = first;
        return string(b);
    }

    function _accepts(string memory destination) internal returns (bool ok) {
        try token.burn{value: FEE}(1, destination) {
            ok = true;
        } catch (bytes memory reason) {
            // Only the destination check may refuse these burns.
            assertEq(bytes4(reason), BridgeToken.BadAddress.selector);
        }
    }

    // ------------------------------------------------------------ destinations

    function test_classicAddressesOfTwentyFiveToThirtyFiveCharactersStartingWithRAreAccepted() public {
        for (uint256 n = 25; n <= 35; n++) {
            assertTrue(_accepts(_filled(n, "r")), string.concat("length ", vm.toString(n)));
        }
        assertTrue(_accepts(R_ADDRESS));
    }

    function test_classicAddressesOutsideThatLengthAreRefused() public {
        assertFalse(_accepts(_filled(24, "r")));
        assertFalse(_accepts(_filled(36, "r")));
        assertFalse(_accepts(_filled(1, "r")));
        assertFalse(_accepts(""));
    }

    function test_xAddressesOfFortySevenCharactersStartingWithXOrTAreAccepted() public {
        assertEq(bytes(X_ADDRESS).length, 47);
        assertEq(bytes(T_ADDRESS).length, 47);
        assertTrue(_accepts(X_ADDRESS));
        assertTrue(_accepts(T_ADDRESS));
        assertTrue(_accepts(_filled(47, "X")));
        assertTrue(_accepts(_filled(47, "T")));
    }

    function test_xAddressesOfAnyOtherLengthAreRefused() public {
        assertFalse(_accepts(_filled(46, "X")));
        assertFalse(_accepts(_filled(48, "X")));
        assertFalse(_accepts(_filled(46, "T")));
        assertFalse(_accepts(_filled(48, "T")));
    }

    function test_theWrongFirstCharacterIsRefusedAtEveryLength() public {
        assertFalse(_accepts(_filled(47, "r")));
        assertFalse(_accepts(_filled(34, "X")));
        assertFalse(_accepts(_filled(34, "T")));
        assertFalse(_accepts(_filled(34, "R")));
        assertFalse(_accepts(_filled(34, "x")));
        assertFalse(_accepts(_filled(47, "x")));
        assertFalse(_accepts(_filled(47, "t")));
        assertFalse(_accepts(_filled(34, "1")));
        assertFalse(_accepts(_filled(34, 0x00)));
    }

    /// Every length from 0 to 100 against every first character that matters.
    function test_destinationRuleAtEveryLength() public {
        bytes memory firsts = "rXTxtR1";
        for (uint256 n = 0; n <= 100; n++) {
            for (uint256 f = 0; f < firsts.length; f++) {
                bytes1 first = firsts[f];
                bool classic = n >= 25 && n <= 35 && first == "r";
                bool xaddress = n == 47 && (first == "X" || first == "T");
                assertEq(_accepts(_filled(n, first)), classic || xaddress, string.concat("length ", vm.toString(n), " first ", vm.toString(uint8(first))));
            }
        }
    }

    function test_theBurnEventCarriesTheDestinationExactlyAsSent() public {
        vm.expectEmit(true, true, false, true, address(token));
        emit BridgeToken.Burn(address(this), 5e18, X_ADDRESS, 1);
        token.burn{value: FEE}(5e18, X_ADDRESS);
        vm.expectEmit(true, true, false, true, address(token));
        emit BridgeToken.Burn(address(this), 6e18, T_ADDRESS, 2);
        token.burn{value: FEE}(6e18, T_ADDRESS);
        vm.expectEmit(true, true, false, true, address(token));
        emit BridgeToken.Burn(address(this), 7e18, R_ADDRESS, 3);
        token.burn{value: FEE}(7e18, R_ADDRESS);
        assertEq(token.burnCount(), 3);
    }

    // ------------------------------------------------------------ the interface the cluster depends on

    function test_theBurnEventAndFunctionKeepTheirSignatures() public pure {
        assertEq(BridgeToken.Burn.selector, keccak256("Burn(address,uint256,string,uint256)"));
        assertEq(BridgeToken.burn.selector, bytes4(keccak256("burn(uint256,string)")));
        assertEq(BridgeToken.MetadataUpdated.selector, keccak256("MetadataUpdated(string,string,string)"));
    }

    function test_theBurnEventHasTheSameIndexedFields() public {
        vm.recordLogs();
        token.burn{value: FEE}(5e18, R_ADDRESS);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        Vm.Log memory burn_;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == BridgeToken.Burn.selector) burn_ = logs[i];
        }
        // topic0 the event, topic1 the burner, topic2 the nonce; the amount and destination ride in the data.
        assertEq(burn_.topics.length, 3);
        assertEq(address(uint160(uint256(burn_.topics[1]))), address(this));
        assertEq(uint256(burn_.topics[2]), 1);
        (uint256 amount, string memory rAddress) = abi.decode(burn_.data, (uint256, string));
        assertEq(amount, 5e18);
        assertEq(rAddress, R_ADDRESS);
    }

    // ------------------------------------------------------------ the order of the checks

    function test_aZeroAmountIsRefusedBeforeAnythingElse() public {
        vm.expectRevert(BridgeToken.BadAmount.selector);
        token.burn(0, "not-an-address");
        vm.expectRevert(BridgeToken.BadAmount.selector);
        token.burn{value: 7}(0, R_ADDRESS);
    }

    function test_aBadDestinationIsRefusedBeforeTheFeeIsLookedAt() public {
        vm.expectRevert(BridgeToken.BadAddress.selector);
        token.burn(1, "not-an-address");
        vm.expectRevert(BridgeToken.BadAddress.selector);
        token.burn{value: 7}(1, "not-an-address");
    }

    function test_theTokenKeepsNoXrp() public {
        token.burn{value: FEE}(1e18, R_ADDRESS);
        token.burn{value: FEE}(1e18, X_ADDRESS);
        assertEq(address(token).balance, 0);
        assertEq(address(minter).balance, 2 * FEE);
    }

    function test_nobodyCanPayTheFeeToTheTokenDirectly() public {
        (bool ok,) = address(token).call{value: 1}("");
        assertFalse(ok);
        assertEq(address(token).balance, 0);
    }
}
