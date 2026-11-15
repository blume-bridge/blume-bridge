// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ThresholdMinter} from "../src/bridge/ThresholdMinter.sol";

/// Deploys the ThresholdMinter (which deploys its TokenFactory) with the cluster's operator EVM addresses as signers.
/// The minter has no owner and no upgrade path, so the code and these values are permanent once deployed: later, k
/// signers can rotate the signer set and change the burn fee within its 1 XRP ceiling, and nothing else about it
/// changes (the rotation delay never does). Nothing here has a default: a missing variable stops the script.
///
///   SIGNERS          comma-separated operator EVM addresses, 1 to 32, no duplicates
///   THRESHOLD        k, the signatures an action needs: 1 to the number of signers
///   ROTATION_DELAY   seconds a proposed signer-set rotation waits before it can execute; never 0, and on mainnet
///                    between 1 hour and 30 days (it is the one value that cannot be changed later, so a slip in units is caught here)
///   BURN_FEE         the exit fee in wei of XRP: 250000000000000000 is 0.25 XRP; the contract refuses more than 1 XRP
///   EXPECT_CHAIN_ID  the chain this deploy is meant for; the script stops if the RPC is on any other
///
/// Mainnet (chain 1440000; gas estimation works there, so no gas flags):
///   SIGNERS=0xa,0xb,0xc,0xd,0xe THRESHOLD=3 ROTATION_DELAY=259200 BURN_FEE=250000000000000000 EXPECT_CHAIN_ID=1440000 \
///     forge script script/DeployBridge.s.sol --rpc-url xrpl_evm_mainnet --broadcast --slow
/// Testnet (chain 1449000; gas estimation is broken there, hence --legacy):
///   SIGNERS=0xa,0xb,0xc THRESHOLD=2 ROTATION_DELAY=3600 BURN_FEE=250000000000000000 EXPECT_CHAIN_ID=1449000 \
///     forge script script/DeployBridge.s.sol --rpc-url xrpl_evm_testnet --broadcast --legacy --slow
/// Without --broadcast it is a dry run: the same checks and logs, nothing sent.
/// On mainnet the script also requires THRESHOLD to be a majority of SIGNERS, every signer to be a plain account, and at least 3
/// signers unless ALLOW_SMALL_SET=true. Before broadcasting, put the signers beside the cluster's own list (`operators`, the `evmAddress`
/// of each signer): a signer that is not a node's key is a share of the vote nobody can cast, and the set cannot be fixed for 3 days.
///
/// After a broadcast, read the deployed minter back from the chain itself (cast call <minter> "threshold()(uint8)",
/// "rotationDelay()(uint256)", "burnFee()(uint256)", "signers()(address[])"): the read-back below runs on the
/// deployment forge simulates first, which proves the constructor wiring, not what landed on the chain.
contract DeployBridge is Script {
    uint256 private constant MAINNET_CHAIN_ID = 1440000;

    function run() external returns (ThresholdMinter minter) {
        address[] memory signers = _split(vm.envString("SIGNERS"));
        uint256 threshold = vm.envUint("THRESHOLD");
        uint256 rotationDelay = vm.envUint("ROTATION_DELAY");
        uint256 burnFee = vm.envUint("BURN_FEE");
        uint256 expectChainId = vm.envUint("EXPECT_CHAIN_ID");

        require(
            block.chainid == expectChainId,
            string.concat("wrong chain: the RPC is on ", vm.toString(block.chainid), " but EXPECT_CHAIN_ID is ", vm.toString(expectChainId))
        );
        // The contract checks the signer set, the threshold and the fee ceiling too; failing here is earlier and says
        // which variable is wrong. `threshold` is range-checked before it is narrowed to the uint8 the constructor
        // takes, so 258 can never become 2.
        require(signers.length <= 32, "SIGNERS: at most 32");
        require(threshold >= 1 && threshold <= signers.length, "THRESHOLD: must be between 1 and the number of SIGNERS");
        require(burnFee <= 1 ether, "BURN_FEE: above the contract's 1 XRP ceiling (MAX_BURN_FEE)");
        require(rotationDelay > 0, "ROTATION_DELAY: 0 would let k keys swap the signer set at once");
        if (block.chainid == MAINNET_CHAIN_ID) {
            require(rotationDelay >= 1 hours && rotationDelay <= 30 days, "ROTATION_DELAY: on mainnet it must be 1 hour to 30 days, in seconds");
            // These values are permanent and move real money. The contract takes any threshold and any address; the cluster refuses a set
            // that is not a majority, so a minter that allows less would accept signatures the cluster never gathers. Not a place for a typo.
            require(threshold * 2 > signers.length, "THRESHOLD: on mainnet it must be a majority of SIGNERS (more than half)");
            require(signers.length >= 3 || vm.envOr("ALLOW_SMALL_SET", false), "SIGNERS: on mainnet fewer than 3 is a single key or a pair; set ALLOW_SMALL_SET=true if that is meant");
            for (uint256 i = 0; i < signers.length; i++) {
                // A signer is a node's key. A contract address (a typo, or a multisig that cannot sign EIP-712 digests) would count toward the threshold and never sign.
                require(signers[i].code.length == 0, "SIGNERS: on mainnet every signer must be a plain account, not a contract");
            }
        }

        console2.log("chain id", block.chainid);
        for (uint256 i = 0; i < signers.length; i++) {
            console2.log("signer", i, signers[i]);
        }
        console2.log("threshold", threshold);
        console2.log("rotation delay (seconds)", rotationDelay);
        console2.log("burn fee (wei of XRP)", burnFee);

        vm.startBroadcast();
        // casting to 'uint8' is safe because THRESHOLD was checked above to be at most the number of signers, and that is at most 32
        // forge-lint: disable-next-line(unsafe-typecast)
        minter = new ThresholdMinter(signers, uint8(threshold), rotationDelay, burnFee);
        vm.stopBroadcast();

        // Read back what the constructor stored, so a wrong value here fails before anyone relies on the address.
        address[] memory stored = minter.signers();
        require(stored.length == signers.length, "readback: signer count");
        for (uint256 i = 0; i < signers.length; i++) {
            require(stored[i] == signers[i] && minter.isSigner(signers[i]), "readback: signer");
        }
        require(minter.threshold() == threshold, "readback: threshold");
        require(minter.rotationDelay() == rotationDelay, "readback: rotation delay");
        require(minter.burnFee() == burnFee, "readback: burn fee");

        console2.log("ThresholdMinter", address(minter));
        console2.log("TokenFactory", address(minter.factory()));
        console2.log("EIP-712 domain: BlumeBridge, version 3, verifyingContract = ThresholdMinter above");
    }

    /// Splits "0xa, 0xb,0xc" on commas, ignoring spaces and tabs around each entry; an empty entry stops the script.
    function _split(string memory raw) internal pure returns (address[] memory out) {
        bytes memory b = bytes(raw);
        uint256 n = 1;
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] == ",") n++;
        }
        out = new address[](n);
        uint256 start = 0;
        uint256 k = 0;
        for (uint256 i = 0; i <= b.length; i++) {
            if (i == b.length || b[i] == ",") {
                uint256 from = start;
                uint256 to = i;
                while (from < to && _isBlank(b[from])) from++;
                while (to > from && _isBlank(b[to - 1])) to--;
                require(to > from, "SIGNERS: empty entry");
                bytes memory part = new bytes(to - from);
                for (uint256 j = from; j < to; j++) {
                    part[j - from] = b[j];
                }
                out[k++] = vm.parseAddress(string(part));
                start = i + 1;
            }
        }
    }

    function _isBlank(bytes1 c) private pure returns (bool) {
        return c == 0x20 || c == 0x09;
    }
}
