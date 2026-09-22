// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IETHDistributable {
    function distributeETHForBurning() external payable;
}

/**
 * @title  MintVault
 * @notice Accumulates 45% of all mint fees in perpetual 1000-day cycles.
 *
 *         - The clock starts when the FIRST mint ever is created on the
 *           Token contract (notifyFirstMint).
 *         - When a cycle completes, anyone can call sweep(): the entire
 *           balance is pushed into the TOKEN buy-and-burn's drip pool and
 *           the next 1000-day cycle begins immediately.
 *         - Cycle boundaries are anchored to genesis, so a late sweep does
 *           not drift the schedule.
 *         - The sweep caller earns a small incentive so keeper bots fire
 *           it promptly at each boundary.
 *
 * @dev    No owner. Nothing here is adjustable, pausable, or withdrawable
 *         by anyone. ETH only leaves through sweep(), only to the
 *         buy-and-burn, only after a full cycle.
 */
contract MintVault is ReentrancyGuard {
    /// @notice Cycle length, fixed at deployment.
    ///         MAINNET: 86_400_000 (1000 days). TESTNET: 604_800 (7 days).
    uint256 public immutable CYCLE_LENGTH;

    /// @dev 0.5% of the swept amount to the caller (in basis points).
    uint256 public constant SWEEP_INCENTIVE_BPS = 50;
    uint256 public constant BPS_DENOM = 10_000;

    address public immutable token;
    address public immutable tokenBuyAndBurn;

    /// @notice 0 until the first mint starts the clock.
    uint256 public genesisTs;

    /// @notice Completed sweeps; cycle N covers
    ///         [genesisTs + N*CYCLE_LENGTH, genesisTs + (N+1)*CYCLE_LENGTH).
    uint256 public currentCycle;

    uint256 public totalSwept;

    event ClockStarted(uint256 genesisTs);
    event Received(address indexed from, uint256 amount);
    event Swept(uint256 indexed cycle, uint256 amount, uint256 incentive, address indexed caller);

    error ZeroAddress();
    error InvalidCycleLength();
    error OnlyToken();
    error ClockAlreadyStarted();
    error ClockNotStarted();
    error CycleNotComplete(uint256 cycleEndsAt);
    error NothingToSweep();
    error IncentiveTransferFailed();

    constructor(address _token, address _tokenBuyAndBurn, uint256 _cycleLength) {
        if (_token == address(0) || _tokenBuyAndBurn == address(0)) revert ZeroAddress();
        if (_cycleLength == 0) revert InvalidCycleLength();
        token = _token;
        tokenBuyAndBurn = _tokenBuyAndBurn;
        CYCLE_LENGTH = _cycleLength;
    }

    receive() external payable {
        emit Received(msg.sender, msg.value);
    }

    /// @notice Called once by the Token contract on the first-ever mint.
    function notifyFirstMint() external {
        if (msg.sender != token) revert OnlyToken();
        if (genesisTs != 0) revert ClockAlreadyStarted();
        genesisTs = block.timestamp;
        emit ClockStarted(block.timestamp);
    }

    /// @notice Timestamp at which the current cycle can be swept.
    function currentCycleEnd() public view returns (uint256) {
        if (genesisTs == 0) return type(uint256).max;
        return genesisTs + (currentCycle + 1) * CYCLE_LENGTH;
    }

    /**
     * @notice Sweeps the full vault balance into the TOKEN buy-and-burn
     *         once the current 1000-day cycle has elapsed. Permissionless;
     *         caller receives SWEEP_INCENTIVE_BPS of the swept amount.
     */
    function sweep() external nonReentrant {
        if (genesisTs == 0) revert ClockNotStarted();
        uint256 cycleEnd = currentCycleEnd();
        if (block.timestamp < cycleEnd) revert CycleNotComplete(cycleEnd);

        uint256 balance = address(this).balance;
        if (balance == 0) revert NothingToSweep();

        // Advance to whichever cycle "now" falls in, so multiple missed
        // boundaries cannot be swept repeatedly for multiple incentives.
        currentCycle = (block.timestamp - genesisTs) / CYCLE_LENGTH;

        uint256 incentive = (balance * SWEEP_INCENTIVE_BPS) / BPS_DENOM;
        uint256 toBurn = balance - incentive;

        totalSwept += toBurn;

        IETHDistributable(tokenBuyAndBurn).distributeETHForBurning{value: toBurn}();

        (bool ok, ) = msg.sender.call{value: incentive}("");
        if (!ok) revert IncentiveTransferFailed();

        emit Swept(currentCycle, toBurn, incentive, msg.sender);
    }
}