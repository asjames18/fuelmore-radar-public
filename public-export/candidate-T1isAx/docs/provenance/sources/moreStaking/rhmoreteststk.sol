// SPDX-License-Identifier: MIT

pragma solidity 0.8.20;

import "https://github.com/OpenZeppelin/openzeppelin-contracts/blob/v4.9.3/contracts/access/Ownable.sol";
import "https://github.com/OpenZeppelin/openzeppelin-contracts/blob/v4.9.3/contracts/token/ERC20/IERC20.sol";
import "https://github.com/OpenZeppelin/openzeppelin-contracts/blob/v4.9.3/contracts/token/ERC20/utils/SafeERC20.sol";
import "https://github.com/OpenZeppelin/openzeppelin-contracts/blob/v4.9.3/contracts/security/ReentrancyGuard.sol";
import "https://github.com/OpenZeppelin/openzeppelin-contracts/blob/v4.9.3/contracts/utils/structs/EnumerableSet.sol";

/**
 * @title  RobinhoodMoreStaking
 * @notice Original single-pool staking mechanics — no penalty split, no
 *         buy-and-burn routing. 100% of every early/late-exit penalty is
 *         recycled straight back into the reward pool for remaining
 *         stakers, exactly matching the very first Staking.sol deployed
 *         on Ethereum.
 * @dev    CHANGE FROM THE ORIGINAL: the token address is a constructor
 *         parameter instead of hardcoded to real $MORE's Ethereum address.
 *         Real $MORE has no native or bridged presence on Robinhood Chain
 *         confirmed yet — this points at a mock token for now (same
 *         mock-token pattern used for every other testnet deployment in
 *         this build). Swap in the real bridged MORE address once that
 *         exists and is confirmed, by deploying a fresh instance — this
 *         contract has no way to change its token post-deploy, same as
 *         the original never needed to.
 *
 *         Everything else — early/late penalty math, stake bookkeeping,
 *         reward index, __updatePool — is byte-for-byte the same logic as
 *         the original Staking.sol.
 */
contract RobinhoodMoreStaking is Ownable, ReentrancyGuard {
	using EnumerableSet for EnumerableSet.UintSet;
	using SafeERC20 for IERC20;

	/// @notice Total principal currently staked.
	uint256 public totalStaked;

	/// @notice Cumulative amount of rewards ever routed into distribution via `__updatePool`.
	uint256 public totalDistributed;

	/// @notice Rewards waiting to be distributed to stakers.
    uint256 public pendingToDistribute;

	/// @notice Global cumulative rewards per token (scaled by `PRECISION_FACTOR`).
    uint256 public rewardPerToken;

	/// @notice Counter for generating unique stake IDs (incremented for each new stake).
    uint256 public stakeIDCounter;

	/// @notice Current number of active stakes across all users.
    uint256 public stakeCounter;

	/// @notice Current number of unique stakers with at least one active stake.
    uint256 public stakers;

	/// @notice Minimum permissible staking duration.
	uint256 private immutable MIN_STAKE_DURATION;

	/// @notice Maximum permissible staking duration.
	uint256 private immutable MAX_STAKE_DURATION;

	/// @notice Grace period after stake end where no late penalty applies.
    uint256 private immutable LATE_PENALTY_GRACE;

	/// @notice Scale factor used to compute late penalties after grace.
    uint256 private immutable LATE_PENALTY_SCALE;

	/// @notice Precision scaler for reward math.
	uint256 private immutable PRECISION_FACTOR;

	/// @notice The ERC-20 token being staked and paid as rewards.
	IERC20 public immutable MORE;

	/// @notice Per-stake data tracked for each unique `stakeID`.
    struct StakeInfo {
		address	staker;
		uint256	amount;
		uint256 startTime;
		uint256 endTime;
		uint256 claimTime;
		uint256 duration;
		uint256 rewardPerToken;
		uint256 claimed;
		uint256 penalty;
		bool status;
    }

	/// @notice Mapping from stake ID to its metadata.
    mapping(uint256 => StakeInfo) public stakeInfo;

	/// @notice Tracks all stake IDs owned by a given staker.
    mapping(address => EnumerableSet.UintSet) private stakerID;

	/// @notice Tracks the number of active stakes held by each staker.
    mapping(address => uint256) public activeStake;

    event Staked(uint256 indexed stakeId, address indexed staker, uint256 amount, uint256 duration);
    event Unstaked(uint256 indexed stakeId);
    event Recovered(address token, uint256 amount);

	/**
     * @param _token Address of the token to stake/reward — a mock MORE
     *        token on Robinhood Chain Testnet for now.
     */
    constructor(address _token) {
		require(_token != address(0), "Zero address");
		MIN_STAKE_DURATION = 1 days;
		MAX_STAKE_DURATION = 5555 days;
		LATE_PENALTY_GRACE = 14 days;
		LATE_PENALTY_SCALE = 700 days;
		PRECISION_FACTOR = 10**18;
		stakeIDCounter = 1;
		MORE = IERC20(_token);
    }

    function getStakerID(address staker) external view returns (uint256[] memory) {
		return stakerID[staker].values();
    }

	function getStakeCount(address staker) external view returns (uint256) {
		return stakerID[staker].length();
	}

	function getStakeIdAt(address staker, uint256 index) external view returns (uint256) {
		return stakerID[staker].at(index);
	}

    function getStakeInfo(uint256 stakeID) external view returns (StakeInfo memory) {
		return stakeInfo[stakeID];
    }

    function stake(uint256 amount, uint256 stakeDays) external nonReentrant {
		uint256 duration = stakeDays * MIN_STAKE_DURATION;
		require(amount > 0, "Amount must be greater than zero");
		require(duration >= MIN_STAKE_DURATION && duration <= MAX_STAKE_DURATION, "Invalid duration");

		MORE.safeTransferFrom(msg.sender, address(this), amount);
		uint256 stakeID = stakeIDCounter;
        stakeInfo[stakeID] = StakeInfo({
			staker: msg.sender,
			amount: amount,
			startTime: block.timestamp,
			endTime: block.timestamp + duration,
			claimTime: 0,
			duration: duration,
			rewardPerToken: ((amount * rewardPerToken) / (PRECISION_FACTOR)),
			claimed: 0,
			penalty: 0,
			status: true
        });

		totalStaked += amount;
		if (pendingToDistribute > 0) {
			__updatePool(0);
		}
		stakerID[msg.sender].add(stakeID);
		stakeIDCounter++;
		stakeCounter++;
		if(activeStake[msg.sender] == 0) {
			stakers++;
		}
		activeStake[msg.sender]++;
        emit Staked(stakeID, msg.sender, amount, duration);
    }

	/**
     * @notice Exit a stake. 100% of any penalty is recycled straight back
     *         into the reward pool — no split, no buy-and-burn routing.
     */
    function unstake(uint256 stakeID) external nonReentrant {
		StakeInfo storage info = stakeInfo[stakeID];
		require(info.staker == msg.sender, "Invalid staker");
		require(info.status, "Already unstake");

        totalStaked -= info.amount;

		(uint256 amountToPay, uint256 penaltyToPay) = __takePenalty(stakeID);

		if(amountToPay > 0) {
			MORE.safeTransfer(msg.sender, amountToPay);
		}
		if(penaltyToPay > 0) {
			__updatePool(penaltyToPay);
		}
		info.status = false;
		info.claimTime = block.timestamp;
		info.claimed = amountToPay;
		info.penalty = penaltyToPay;
		stakeCounter--;
		activeStake[msg.sender]--;
		if(activeStake[msg.sender] == 0) {
			stakers--;
		}
        emit Unstaked(stakeID);
    }

	function earned(uint256 stakeID) public view returns (uint256) {
		StakeInfo memory info = stakeInfo[stakeID];
		if(info.amount > 0 && info.status) {
			return (((info.amount * rewardPerToken) / PRECISION_FACTOR) - (info.rewardPerToken));
		} else {
			return 0;
		}
    }

	/**
     * @notice Recover arbitrary ERC-20 tokens accidentally sent to this contract.
     * @dev Cannot recover the staking token.
     */
    function recoverToken(address token, uint256 amount) external onlyOwner {
		require(token != address(MORE), "Can't recover staking token");
		IERC20(token).safeTransfer(msg.sender, amount);
		emit Recovered(token, amount);
    }

    function __takePenalty(uint256 stakeID) internal view returns (uint256, uint256) {
		StakeInfo memory info = stakeInfo[stakeID];
		uint256 penalty;
		uint256 amount = info.amount + earned(stakeID);

        if (block.timestamp < info.endTime) {
			uint256 unservedDays = info.endTime - block.timestamp;
			penalty = (amount * unservedDays) / info.duration;
        } else {
			if (block.timestamp > (info.endTime + LATE_PENALTY_GRACE)) {
				penalty = (amount * (block.timestamp - info.endTime - LATE_PENALTY_GRACE)) / LATE_PENALTY_SCALE;
			}
        }

		if (penalty > amount) {
			penalty = amount;
		}
        return (amount - penalty, penalty);
    }

	function __updatePool(uint256 amount) internal {
		if(totalStaked > 0) {
			uint256 totalAmount = pendingToDistribute + amount;
			rewardPerToken += (totalAmount * PRECISION_FACTOR / totalStaked);
			pendingToDistribute = 0;
		} else {
			pendingToDistribute += amount;
		}
		totalDistributed += amount;
    }
}