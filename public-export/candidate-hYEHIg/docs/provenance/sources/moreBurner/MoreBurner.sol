// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/* === UNIV3 === */
import {TickMath} from "https://github.com/Uniswap/v3-core/blob/0.8/contracts/libraries/TickMath.sol";
import {OracleLibrary} from "./library/OracleLibrary.sol";
import {IV3SwapRouter} from "./interfaces/IV3SwapRouter.sol";
import {TransferHelper} from "./library/TransferHelper.sol";

/* === OZ === */
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/* === CONST === */
import "./const/TokenConst.sol";

/**
 * @title  MoreBurner
 * @notice Receives the 30% leg of every mint fee, accumulates it as ETH, and
 *         drip-buys $MORE through the MORE/WETH V3 1% pool, sending all
 *         purchased MORE to the dead address (MORE has no native burn).
 *
 *         Uses the same machinery as the TOKEN buy-and-burn:
 *           - 10-minute intervals, 144/day, default 1%/day of the pool
 *             (owner-adjustable 1-10%)
 *           - permissionless keeper entry with a 1.5% ETH incentive
 *           - 15-minute TWAP slippage guard, owner-adjustable tolerance
 *
 * @dev    PRE-DEPLOY DEPENDENCY: the MORE/WETH pool at MORE_WETH_POOL must
 *         hold the migrated liquidity and have observation cardinality
 *         expanded (increaseObservationCardinalityNext) or every swap's
 *         TWAP consult will revert.
 */
contract MoreBurner is ReentrancyGuard, Ownable2Step {
    uint32 public immutable startTimeStamp;

    struct IntervalBurn {
        uint128 amountAllocated;
        uint128 amountBurned;
    }

    uint256 public totalMoreBurnt;
    uint256 public ethUsedForBurns;

    /// @notice ETH awaiting drip-conversion to MORE.
    uint256 public totalETHBurn;

    /// @notice Daily drip in basis points of the pool balance (100 = 1%).
    uint256 public DAILY_ALLOCATION_ETH_BURNING = 100;

    mapping(uint32 => IntervalBurn) public ethIntervalsBurn;
    uint32 public lastETHBurnIntervalNumber;
    uint32 public lastBurnedETHIntervalStartTimestamp;

    uint8 public ethToMoreSlippage = 10;

    modifier burnETHIntervalUpdate() {
        _intervalUpdateETHForBurning();
        _;
    }

    event MoreBoughtAndBurned(uint256 indexed ethAmount, uint256 indexed moreBurnt, address indexed caller);
    event DailyAllocationETHBurningUpdated(uint256 newDailyAllocation);
    event ETHToMoreSlippageUpdated(uint8 newSlippage);

    error NotStartedYet();
    error InvalidInput();
    error DeadlinePassed();
    error IntervalAlreadyBurned();

    constructor(uint32 _startTimestamp, address _owner) Ownable(_owner) {
        // 0 = start now. Non-zero values more than 30 days out are rejected.
        uint32 start = _startTimestamp == 0 ? uint32(block.timestamp) : _startTimestamp;
        if (start > block.timestamp + 30 days) revert InvalidInput();

        startTimeStamp = start;
        lastBurnedETHIntervalStartTimestamp = start;
    }

    /// @notice Any plain ETH transfer is credited exactly like
    ///         distributeETHForBurning() — there is no way to send ETH to
    ///         this contract that becomes stuck outside the burn accounting.
    ///         (Previously a bare no-op — same gap found and fixed in
    ///         TokenBuyAndBurn; found via community testing.)
    receive() external payable {
        if (msg.value == 0) return; // harmless no-op for a zero-value probe
        _creditETHForBurning(msg.value);
    }

    /* ================================================================
                               DEPOSIT (ETH IN)
       ================================================================ */

    /// @notice Entry point for the FeeDistributor's 30% leg.
    function distributeETHForBurning() external payable {
        if (msg.value == 0) revert InvalidInput();
        _creditETHForBurning(msg.value);
    }

    function _creditETHForBurning(uint256 amount) private {
        // See TokenBuyAndBurn._creditETHForBurning for the full explanation —
        // same fix, same bug: deposits no longer trigger interval bookkeeping,
        // only the swap function's own modifier does.
        totalETHBurn += amount;
    }

    /* ================================================================
                             BURN (keeper entry)
       ================================================================ */

    /**
     * @notice Swaps the current interval's ETH allocation for MORE and sends
     *         it to the dead address. Permissionless; caller earns 1.5%.
     */
    function swapETHForMoreAndBurn(uint32 _deadline) external nonReentrant burnETHIntervalUpdate {
        IntervalBurn storage currInterval = ethIntervalsBurn[lastETHBurnIntervalNumber];
        if (currInterval.amountBurned != 0) revert IntervalAlreadyBurned();

        uint256 amountAllocated = currInterval.amountAllocated;
        currInterval.amountBurned = currInterval.amountAllocated;

        uint256 incentive = (amountAllocated * INCENTIVE_FEE) / BPS_DENOM;
        uint256 ethToSwapAndBurn = amountAllocated - incentive;

        uint256 moreAmount = _swapETHForMore(ethToSwapAndBurn, _deadline);

        ethUsedForBurns += ethToSwapAndBurn;
        totalETHBurn -= amountAllocated;
        totalMoreBurnt += moreAmount;

        // MORE has no burn function; the dead address is the burn.
        TransferHelper.safeTransfer(MORE_ADDRESS, DEAD_ADDRESS, moreAmount);

        (bool success, ) = payable(msg.sender).call{value: incentive, gas: 30000}("");
        require(success, "Transfer failed");

        emit MoreBoughtAndBurned(ethToSwapAndBurn, moreAmount, msg.sender);
    }

    /* ================================================================
                              OWNER SETTINGS
       ================================================================ */

    function setDailyAllocationETHBurning(uint256 _newDailyAllocation) external onlyOwner {
        DAILY_ALLOCATION_ETH_BURNING = _newDailyAllocation;
        require(
            DAILY_ALLOCATION_ETH_BURNING >= 100 && DAILY_ALLOCATION_ETH_BURNING <= 1000,
            "Min 1%, max 10%"
        );
        _intervalUpdateETHForBurning();

        emit DailyAllocationETHBurningUpdated(_newDailyAllocation);
    }

    function setSlippageForETHToMore(uint8 _newSlippage) external onlyOwner {
        if (_newSlippage > 100 || _newSlippage < 2) revert InvalidInput();
        ethToMoreSlippage = _newSlippage;

        emit ETHToMoreSlippageUpdated(_newSlippage);
    }

    /* ================================================================
                          INTERNAL: INTERVAL LOGIC
                 (verbatim from LessBuyAndProcess, ETH path)
       ================================================================ */

    function _calculateIntervalsETHBurn(
        uint256 timeElapsed
    )
        internal
        view
        returns (uint32 _lastIntervalNumber, uint128 _totalAmountForInterval, uint32 missedIntervals)
    {
        missedIntervals = lastBurnedETHIntervalStartTimestamp == 0
            ? (timeElapsed <= INTERVAL_TIME ? 0 : uint32(timeElapsed / INTERVAL_TIME))
            : (timeElapsed <= INTERVAL_TIME ? 0 : uint32(timeElapsed / INTERVAL_TIME) - 1);
        _lastIntervalNumber = lastETHBurnIntervalNumber + missedIntervals + 1;
        uint256 dailyAllocation = (totalETHBurn * DAILY_ALLOCATION_ETH_BURNING) / BPS_DENOM;
        uint128 amountPerInterval = uint128(dailyAllocation / INTERVALS_PER_DAY);
        uint128 additionalAmount = amountPerInterval * missedIntervals;
        _totalAmountForInterval = amountPerInterval + additionalAmount;
        if (_totalAmountForInterval > totalETHBurn) {
            _totalAmountForInterval = uint128(totalETHBurn);
        }
    }

    function _intervalUpdateETHForBurning() private {
        if (block.timestamp < startTimeStamp) revert NotStartedYet();
        uint32 timeElapsed = lastBurnedETHIntervalStartTimestamp == 0
            ? uint32(block.timestamp - startTimeStamp)
            : uint32(block.timestamp - lastBurnedETHIntervalStartTimestamp);
        uint32 _lastInterval;
        uint128 _amountAllocated;
        uint32 _missedIntervals;
        uint32 _intervalStart;
        bool updated = false;
        if (lastBurnedETHIntervalStartTimestamp == 0) {
            (_lastInterval, _amountAllocated, _missedIntervals) =
                _calculateIntervalsETHBurn(timeElapsed);
            _intervalStart = startTimeStamp;
            updated = true;
        } else if (timeElapsed > INTERVAL_TIME) {
            (_lastInterval, _amountAllocated, _missedIntervals) =
                _calculateIntervalsETHBurn(timeElapsed);
            _intervalStart = lastBurnedETHIntervalStartTimestamp;
            updated = true;
            _missedIntervals++;
        }
        if (updated) {
            lastBurnedETHIntervalStartTimestamp =
                _intervalStart + (_missedIntervals * INTERVAL_TIME);
            ethIntervalsBurn[_lastInterval] =
                IntervalBurn({amountAllocated: _amountAllocated, amountBurned: 0});
            lastETHBurnIntervalNumber = _lastInterval;
        }
    }

    /* ================================================================
                            INTERNAL: SWAP + QUOTE
       ================================================================ */

    /// @dev Single hop ETH -> MORE through the migrated V3 1% pool.
    function _swapETHForMore(
        uint256 ethAmount,
        uint256 _deadline
    ) internal returns (uint256 moreReceived) {
        bytes memory path = abi.encodePacked(WETH_ADDRESS, MORE_WETH_POOL_FEE, MORE_ADDRESS);
        uint256 expectedMoreAmount = getMoreQuoteForETH(ethAmount);
        uint256 adjustedMoreAmount = (expectedMoreAmount * (100 - ethToMoreSlippage)) / 100;
        // SwapRouter02 has no deadline param; enforce it here instead.
        if (block.timestamp > _deadline) revert DeadlinePassed();

        IV3SwapRouter.ExactInputParams memory params = IV3SwapRouter.ExactInputParams({
            path: path,
            recipient: address(this),
            amountIn: ethAmount,
            amountOutMinimum: adjustedMoreAmount
        });

        return IV3SwapRouter(UNISWAP_V3_ROUTER).exactInput{value: ethAmount}(params);
    }

    /// @notice 15-minute TWAP quote of MORE out for `baseAmount` WETH in.
    function getMoreQuoteForETH(uint256 baseAmount) public view returns (uint256 quote) {
        address poolAddress = MORE_WETH_POOL;
        uint32 secondsAgo = 15 * 60;
        uint32 oldestObservation = OracleLibrary.getOldestObservationSecondsAgo(poolAddress);
        if (oldestObservation < secondsAgo) secondsAgo = oldestObservation;
        (int24 arithmeticMeanTick, ) = OracleLibrary.consult(poolAddress, secondsAgo);
        uint160 sqrtPriceX96 = TickMath.getSqrtRatioAtTick(arithmeticMeanTick);
        quote = OracleLibrary.getQuoteForSqrtRatioX96(
            sqrtPriceX96,
            baseAmount,
            WETH_ADDRESS,
            MORE_ADDRESS
        );
    }
}