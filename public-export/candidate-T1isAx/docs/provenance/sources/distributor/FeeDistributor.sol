// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IETHDistributable {
    function distributeETHForBurning() external payable;
}

/**
 * @title  FeeDistributor
 * @notice Receives 100% of mint fees from the Token contract and splits:
 *
 *           45% -> MintVault           (1000-day cycle accumulator)
 *           25% -> TokenBuyAndBurn     (immediate drip burning of TOKEN)
 *           30% -> MoreBurner          (drip buying of MORE -> 0xdEaD)
 *
 *         Fees accumulate here between distributions; distribute() is
 *         permissionless so anyone (keeper bots included) can flush the
 *         balance downstream. Batching keeps the per-mint gas cost of
 *         _collectFee() to a single cheap ETH transfer instead of three
 *         external calls with interval bookkeeping on every mint.
 *
 * @dev    All three destinations are immutable: no owner, no rug surface.
 */
contract FeeDistributor {
    uint256 public constant VAULT_BPS = 4_500; // 45%
    uint256 public constant BURN_BPS = 2_500;  // 25%
    uint256 public constant MORE_BPS = 3_000;  // 30%
    uint256 public constant BPS_DENOM = 10_000;

    /// @dev Ignore dust below this to avoid wasting keeper gas on wei.
    uint256 public constant MIN_DISTRIBUTE = 0.01 ether;

    address public immutable vault;
    address public immutable tokenBuyAndBurn;
    address public immutable moreBurner;

    uint256 public totalDistributed;

    event FeesReceived(address indexed from, uint256 amount);
    event FeesDistributed(uint256 toVault, uint256 toBurn, uint256 toMore);

    error ZeroAddress();
    error NothingToDistribute();
    error VaultTransferFailed();

    constructor(address _vault, address _tokenBuyAndBurn, address _moreBurner) {
        if (_vault == address(0) || _tokenBuyAndBurn == address(0) || _moreBurner == address(0)) {
            revert ZeroAddress();
        }
        vault = _vault;
        tokenBuyAndBurn = _tokenBuyAndBurn;
        moreBurner = _moreBurner;
    }

    /// @notice Token contract forwards fees here; plain ETH also accepted
    ///         (donations just get split the same way).
    receive() external payable {
        emit FeesReceived(msg.sender, msg.value);
    }

    /**
     * @notice Splits the accumulated balance 45/25/30 and pushes it
     *         downstream. Permissionless.
     */
    function distribute() external {
        uint256 balance = address(this).balance;
        if (balance < MIN_DISTRIBUTE) revert NothingToDistribute();

        uint256 toVault = (balance * VAULT_BPS) / BPS_DENOM;
        uint256 toMore = (balance * MORE_BPS) / BPS_DENOM;
        uint256 toBurn = balance - toVault - toMore; // remainder: no dust stranding

        totalDistributed += balance;

        // 45% -> vault (plain transfer; vault has receive())
        (bool ok, ) = vault.call{value: toVault}("");
        if (!ok) revert VaultTransferFailed();

        // 25% -> TOKEN buy-and-burn drip pool
        IETHDistributable(tokenBuyAndBurn).distributeETHForBurning{value: toBurn}();

        // 30% -> MORE burner drip pool
        IETHDistributable(moreBurner).distributeETHForBurning{value: toMore}();

        emit FeesDistributed(toVault, toBurn, toMore);
    }
}