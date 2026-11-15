// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployBridge} from "../../script/DeployBridge.s.sol";
import {ThresholdMinter} from "../../src/bridge/ThresholdMinter.sol";

/// The deploy script's rules, run as the script runs them: environment variables in, a minter out, and a stop with a
/// message for anything a permanent deploy must not accept.
///
/// Environment variables belong to the whole test process and Foundry runs tests in parallel, so everything that sets
/// them lives in this one test, in order. No other test in the suite reads these names.
contract DeployBridgeTest is Test {
    string constant A = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    string constant B = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
    string constant C = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
    string constant FEE = "250000000000000000";

    DeployBridge script;

    function setUp() public {
        script = new DeployBridge();
    }

    function _env(string memory signers, string memory threshold, string memory delay, string memory fee, string memory chain) internal {
        vm.setEnv("SIGNERS", signers);
        vm.setEnv("THRESHOLD", threshold);
        vm.setEnv("ROTATION_DELAY", delay);
        vm.setEnv("BURN_FEE", fee);
        vm.setEnv("EXPECT_CHAIN_ID", chain);
    }

    function _three() internal pure returns (string memory) {
        return string.concat(A, ",", B, ",", C);
    }

    function _refuses(string memory message) internal {
        vm.expectRevert(bytes(message));
        script.run();
    }

    function test_theDeployScriptRules() public {
        string memory here = vm.toString(vm.getChainId());

        // The good case: every value lands in the minter, in order, and the factory belongs to it.
        _env(_three(), "2", "3600", FEE, here);
        ThresholdMinter minter = script.run();
        address[] memory set = minter.signers();
        assertEq(set.length, 3);
        assertEq(set[0], vm.parseAddress(A));
        assertEq(set[1], vm.parseAddress(B));
        assertEq(set[2], vm.parseAddress(C));
        assertEq(minter.threshold(), 2);
        assertEq(minter.rotationDelay(), 3600);
        assertEq(minter.burnFee(), 0.25 ether);
        assertEq(minter.factory().minter(), address(minter));
        assertFalse(minter.paused());

        // The wrong chain stops it before anything is built.
        _env(_three(), "2", "3600", FEE, "1440000");
        _refuses(string.concat("wrong chain: the RPC is on ", here, " but EXPECT_CHAIN_ID is 1440000"));

        // A threshold outside 1..n stops it, and 258 does not wrap to 2.
        _env(_three(), "258", "3600", FEE, here);
        _refuses("THRESHOLD: must be between 1 and the number of SIGNERS");
        _env(_three(), "0", "3600", FEE, here);
        _refuses("THRESHOLD: must be between 1 and the number of SIGNERS");
        _env(_three(), "4", "3600", FEE, here);
        _refuses("THRESHOLD: must be between 1 and the number of SIGNERS");
        _env(_three(), "3", "3600", FEE, here);
        assertEq(script.run().threshold(), 3);

        // The fee: 0 and the 1 XRP ceiling are fine, one wei more is not.
        _env(_three(), "2", "3600", "0", here);
        assertEq(script.run().burnFee(), 0);
        _env(_three(), "2", "3600", "1000000000000000000", here);
        assertEq(script.run().burnFee(), 1 ether);
        _env(_three(), "2", "3600", "1000000000000000001", here);
        _refuses("BURN_FEE: above the contract's 1 XRP ceiling (MAX_BURN_FEE)");

        // No rotation delay at all is refused anywhere.
        _env(_three(), "2", "0", FEE, here);
        _refuses("ROTATION_DELAY: 0 would let k keys swap the signer set at once");

        // The signer list: spaces around entries are fine; empty entries, duplicates, garbage and 33 are not.
        _env(string.concat(A, " , ", B, "\t,", C, " "), "2", "3600", FEE, here);
        assertEq(script.run().signers().length, 3);
        _env(string.concat(A, ",,", B), "2", "3600", FEE, here);
        _refuses("SIGNERS: empty entry");
        _env(string.concat(A, ",", B, ","), "2", "3600", FEE, here);
        _refuses("SIGNERS: empty entry");
        _env("", "1", "3600", FEE, here);
        _refuses("SIGNERS: empty entry");
        _env(string.concat(A, ",", A, ",", B), "2", "3600", FEE, here);
        vm.expectRevert(ThresholdMinter.BadSignerSet.selector);
        script.run();
        // The constructor refused inside the script's broadcast; a real run ends there, a test has to close it.
        vm.stopBroadcast();
        _env(string.concat(A, ",not-an-address"), "1", "3600", FEE, here);
        vm.expectRevert();
        script.run();
        string memory many = vm.toString(address(uint160(0x1000)));
        for (uint256 i = 1; i < 33; i++) many = string.concat(many, ",", vm.toString(address(uint160(0x1000 + i))));
        _env(many, "1", "3600", FEE, here);
        _refuses("SIGNERS: at most 32");

        // A value that is not a number stops it.
        _env(_three(), "two", "3600", FEE, here);
        vm.expectRevert();
        script.run();

        // On mainnet the delay must also be a plausible number of seconds: an hour to 30 days.
        vm.chainId(1440000);
        _env(_three(), "2", "259200", FEE, "1440000");
        assertEq(script.run().rotationDelay(), 3 days);
        _env(_three(), "2", "3600", FEE, "1440000");
        assertEq(script.run().rotationDelay(), 1 hours);
        _env(_three(), "2", "3599", FEE, "1440000");
        _refuses("ROTATION_DELAY: on mainnet it must be 1 hour to 30 days, in seconds");
        _env(_three(), "2", "3", FEE, "1440000"); // days written as if they were seconds
        _refuses("ROTATION_DELAY: on mainnet it must be 1 hour to 30 days, in seconds");
        _env(_three(), "2", "259200000", FEE, "1440000"); // milliseconds written as if they were seconds
        _refuses("ROTATION_DELAY: on mainnet it must be 1 hour to 30 days, in seconds");
        _env(_three(), "2", "2592000", FEE, "1440000");
        assertEq(script.run().rotationDelay(), 30 days);
        _env(_three(), "2", "2592001", FEE, "1440000");
        _refuses("ROTATION_DELAY: on mainnet it must be 1 hour to 30 days, in seconds");
    }
}
