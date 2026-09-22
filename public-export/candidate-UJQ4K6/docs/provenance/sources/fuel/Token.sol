// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Context} from "@openzeppelin/contracts/utils/Context.sol";
import {IERC165} from "@openzeppelin/contracts/interfaces/IERC165.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ABDKMath64x64} from "abdk-libraries-solidity/ABDKMath64x64.sol";
import {IStakingToken} from "./interfaces/IStakingToken.sol";
import {IRankedMintingToken} from "./interfaces/IRankedMintingToken.sol";
import {IBurnableToken} from "./interfaces/IBurnableToken.sol";
import {IBurnRedeemable} from "./interfaces/IBurnRedeemable.sol";
import {IMintVault} from "./interfaces/IMintVault.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @dev Read-back interfaces used only to validate wiring in configureContracts.
interface IWiredVault {
    function token() external view returns (address);
}

interface IWiredBuyAndBurn {
    function token() external view returns (address);
}

interface IWiredDistributor {
    function vault() external view returns (address);
    function tokenBuyAndBurn() external view returns (address);
}

/**
 * @title  Token (XEN fork with mint fees feeding a buy-and-burn ecosystem)
 * @notice Fork of XENCrypto with the following additions:
 *
 *         1. FEE-ON-MINT: claimRank() is payable and charges a fee equal to
 *            the benchmark gas cost of one solo mint:
 *                fee = soloMintGas * max(tx.gasprice, minGasPrice)
 *            The fee is charged PER ADDRESS STARTING A MINT, with no batch
 *            discount and no remint discount (deliberate batcher penalty).
 *            Excess msg.value is refunded.
 *
 *         2. FEE ROUTING: every fee is forwarded to the FeeDistributor,
 *            which splits 45% / 25% / 30% between the 1000-day vault, the
 *            TOKEN buy-and-burn, and the MORE burner.
 *
 *         3. GENESIS CLOCK: the very first mint notifies the vault, which
 *            starts the first 1000-day accumulation cycle.
 *
 *         4. LP MINT HOOK: one-time mint of INITIAL_LP_MINT to the
 *            buy-and-burn contract so it can seed the TOKEN/WETH V3 pool
 *            (mirrors Less.mintTokensForLP()).
 *
 *         All original XEN minting / staking / burning mechanics are
 *         otherwise preserved verbatim.
 *
 * @dev    TODO(DEPLOY-DAY): set final name / symbol below.
 */
contract Token is
    Context,
    Ownable2Step,
    IRankedMintingToken,
    IStakingToken,
    IBurnableToken,
    ERC20("FUEL", "FUEL"),
    ReentrancyGuard
{
    using Math for uint256;
    using ABDKMath64x64 for int128;
    using ABDKMath64x64 for uint256;

    // INTERNAL TYPE TO DESCRIBE A MINT INFO
    struct MintInfo {
        address user;
        uint256 term;
        uint256 maturityTs;
        uint256 rank;
        uint256 amplifier;
        uint256 eaaRate;
    }

    // INTERNAL TYPE TO DESCRIBE A STAKE
    struct StakeInfo {
        uint256 term;
        uint256 maturityTs;
        uint256 amount;
        uint256 apy;
    }

    // PUBLIC CONSTANTS (unchanged from XEN)

    uint256 public constant SECONDS_IN_DAY = 3_600 * 24;
    uint256 public constant DAYS_IN_YEAR = 365;

    uint256 public constant GENESIS_RANK = 1;

    uint256 public constant MIN_TERM = 7 * SECONDS_IN_DAY - 1;
    uint256 public constant MAX_TERM_START = 100 * SECONDS_IN_DAY;
    uint256 public constant MAX_TERM_END = 1_000 * SECONDS_IN_DAY;
    uint256 public constant TERM_AMPLIFIER = 15;
    uint256 public constant TERM_AMPLIFIER_THRESHOLD = 5_000;
    uint256 public constant REWARD_AMPLIFIER_START = 3_000;
    uint256 public constant REWARD_AMPLIFIER_END = 1;
    uint256 public constant EAA_PM_START = 100;
    uint256 public constant EAA_PM_STEP = 1;
    uint256 public constant EAA_RANK_STEP = 100_000;
    uint256 public constant WITHDRAWAL_WINDOW_DAYS = 7;
    uint256 public constant MAX_PENALTY_PCT = 99;

    uint256 public constant MIN_STAKE = 0;
    uint256 public constant MIN_BURN = 0;

    uint256 public constant APY_START = 20;
    uint256 public constant APY_DAYS_STEP = 90;
    uint256 public constant APY_END = 2;

    /// @dev One-time LP seed for the TOKEN/WETH pool, minted to the
    ///      buy-and-burn. TODO(DEPLOY-DAY): size against INITIAL_WETH_FOR_LIQ
    ///      to hit the target launch price.
    uint256 public constant INITIAL_LP_MINT = 1_000_000e18;

    // ==================== FEE STATE (NEW) ====================

    /// @notice Benchmark gas units of one solo claimRank() call.
    ///         Calibrated on testnet; owner-adjustable within hard bounds.
    uint256 public soloMintGas = 150_000;

    /// @notice Floor applied to tx.gasprice when computing the fee, so the
    ///         fee cannot be dusted down in near-zero base-fee conditions.
    uint256 public minGasPrice = 1 gwei;

    /// @dev Hard bounds so the owner key cannot rug minters with a
    ///      pathological fee, nor zero the fee out entirely.
    uint256 public constant SOLO_MINT_GAS_MIN = 50_000;
    uint256 public constant SOLO_MINT_GAS_MAX = 500_000;
    uint256 public constant MIN_GAS_PRICE_MAX = 100 gwei;

    /// @notice Receives 100% of mint fees; splits 45/25/30 downstream.
    address public feeDistributor;

    /// @notice 1000-day cycle vault; its clock starts on the first mint.
    address public vault;

    /// @notice TOKEN buy-and-burn; sole authorized caller of mintTokensForLP.
    address public buyAndBurn;

    bool public lpMinted;

    // ==================== PUBLIC STATE (unchanged) ====================

    uint256 public immutable genesisTs;
    uint256 public globalRank = GENESIS_RANK;
    uint256 public activeMinters;
    uint256 public activeStakes;
    uint256 public totalTokenStaked;
    // user address => mint info
    mapping(address => MintInfo) public userMints;
    // user address => stake info
    mapping(address => StakeInfo) public userStakes;
    // user address => burn amount
    mapping(address => uint256) public userBurns;

    // ==================== EVENTS (NEW) ====================

    event MintFeePaid(address indexed minter, uint256 fee, uint256 gasPriceUsed);
    event ClaimFeePaid(address indexed claimer, uint256 fee, uint256 gasPriceUsed);
    event SoloMintGasUpdated(uint256 newSoloMintGas);
    event MinGasPriceUpdated(uint256 newMinGasPrice);
    event ContractsConfigured(address feeDistributor, address vault, address buyAndBurn);
    event LPTokensMinted(address indexed to, uint256 amount);

    // ==================== ERRORS (NEW) ====================

    error NotConfigured();
    error AlreadyConfigured();
    error ZeroAddress();
    error MisconfiguredVault();
    error MisconfiguredBuyAndBurn();
    error MisconfiguredDistributor();
    error InsufficientFee(uint256 required, uint256 provided);
    error FeeForwardFailed();
    error RefundFailed();
    error OutOfBounds();
    error OnlyBuyAndBurn();
    error LPAlreadyMinted();

    // CONSTRUCTOR
    constructor(address _owner) Ownable(_owner) {
        genesisTs = block.timestamp;
    }

    // ==================== ONE-TIME WIRING (NEW) ====================

    /**
     * @notice One-time wiring of the fee ecosystem. Deployment order:
     *         1. deploy Token
     *         2. deploy Vault, BuyAndBurn, MoreBurner, FeeDistributor
     *         3. call configureContracts()
     *         Mints are impossible until this is called; the wiring is
     *         immutable afterwards, so the owner key cannot re-route fees.
     */
    function configureContracts(
        address _feeDistributor,
        address _vault,
        address _buyAndBurn
    ) external onlyOwner {
        if (feeDistributor != address(0)) revert AlreadyConfigured();
        if (_feeDistributor == address(0) || _vault == address(0) || _buyAndBurn == address(0)) {
            revert ZeroAddress();
        }

        // WIRING VALIDATION: each contract must point back at the right
        // places, or this call reverts. Makes pasting addresses into the
        // wrong slots impossible (added after a testnet mix-up did exactly
        // that and permanently bricked a deployment).
        if (IWiredVault(_vault).token() != address(this)) revert MisconfiguredVault();
        if (address(IWiredBuyAndBurn(_buyAndBurn).token()) != address(this)) revert MisconfiguredBuyAndBurn();
        IWiredDistributor d = IWiredDistributor(_feeDistributor);
        if (d.vault() != _vault || d.tokenBuyAndBurn() != _buyAndBurn) revert MisconfiguredDistributor();

        feeDistributor = _feeDistributor;
        vault = _vault;
        buyAndBurn = _buyAndBurn;
        emit ContractsConfigured(_feeDistributor, _vault, _buyAndBurn);
    }

    // ==================== FEE LOGIC (NEW) ====================

    /// @notice Gas price the fee formula will use for a tx at `gasPrice`.
    function effectiveGasPrice(uint256 gasPrice) public view returns (uint256) {
        return gasPrice > minGasPrice ? gasPrice : minGasPrice;
    }

    /**
     * @notice Fee for one address starting one mint at gas price `gasPrice`.
     * @dev    Frontends should call this with their current gas estimate and
     *         send a buffer on top; the contract refunds the excess.
     */
    function mintFee(uint256 gasPrice) public view returns (uint256) {
        return soloMintGas * effectiveGasPrice(gasPrice);
    }

    /// @notice Basis points of `mintFee` charged when claiming (2500 = 25%).
    ///         Claiming should cost less than starting — this is fixed, not
    ///         owner-adjustable, so the discount can't be quietly reversed.
    uint256 public constant CLAIM_FEE_BPS = 2_500;
    uint256 public constant BPS_DENOM = 10_000;

    /// @notice Fee for one address claiming one matured mint at gas price
    ///         `gasPrice` — 25% of the equivalent mint fee.
    function claimFee(uint256 gasPrice) public view returns (uint256) {
        return (mintFee(gasPrice) * CLAIM_FEE_BPS) / BPS_DENOM;
    }

    /**
     * @dev Collects the mint fee, forwards it to the distributor, refunds
     *      the excess. Reverts if underfunded.
     */
    function _collectMintFee() private {
        if (feeDistributor == address(0)) revert NotConfigured();

        uint256 fee = mintFee(tx.gasprice);
        if (msg.value < fee) revert InsufficientFee(fee, msg.value);

        (bool ok, ) = feeDistributor.call{value: fee}("");
        if (!ok) revert FeeForwardFailed();

        uint256 refund = msg.value - fee;
        if (refund > 0) {
            (bool rOk, ) = _msgSender().call{value: refund}("");
            if (!rOk) revert RefundFailed();
        }

        emit MintFeePaid(_msgSender(), fee, effectiveGasPrice(tx.gasprice));
    }

    /**
     * @dev Collects the (discounted) claim fee, forwards it, refunds the
     *      excess. Reverts if underfunded.
     */
    function _collectClaimFee() private {
        if (feeDistributor == address(0)) revert NotConfigured();

        uint256 fee = claimFee(tx.gasprice);
        if (msg.value < fee) revert InsufficientFee(fee, msg.value);

        (bool ok, ) = feeDistributor.call{value: fee}("");
        if (!ok) revert FeeForwardFailed();

        uint256 refund = msg.value - fee;
        if (refund > 0) {
            (bool rOk, ) = _msgSender().call{value: refund}("");
            if (!rOk) revert RefundFailed();
        }

        emit ClaimFeePaid(_msgSender(), fee, effectiveGasPrice(tx.gasprice));
    }

    /// @notice Adjust the solo-mint gas benchmark (post-launch calibration).
    function setSoloMintGas(uint256 _soloMintGas) external onlyOwner {
        if (_soloMintGas < SOLO_MINT_GAS_MIN || _soloMintGas > SOLO_MINT_GAS_MAX) {
            revert OutOfBounds();
        }
        soloMintGas = _soloMintGas;
        emit SoloMintGasUpdated(_soloMintGas);
    }

    /// @notice Adjust the gas price floor.
    function setMinGasPrice(uint256 _minGasPrice) external onlyOwner {
        if (_minGasPrice == 0 || _minGasPrice > MIN_GAS_PRICE_MAX) revert OutOfBounds();
        minGasPrice = _minGasPrice;
        emit MinGasPriceUpdated(_minGasPrice);
    }

    // ==================== LP MINT HOOK (NEW) ====================

    /**
     * @notice One-time mint of the LP seed to the buy-and-burn so it can
     *         create the TOKEN/WETH pool. Mirrors Less.mintTokensForLP().
     */
    function mintTokensForLP() external {
        if (_msgSender() != buyAndBurn) revert OnlyBuyAndBurn();
        if (lpMinted) revert LPAlreadyMinted();
        lpMinted = true;
        _mint(buyAndBurn, INITIAL_LP_MINT);
        emit LPTokensMinted(buyAndBurn, INITIAL_LP_MINT);
    }

    // ==================== PRIVATE METHODS (unchanged from XEN) ====================

    /**
     * @dev calculates current MaxTerm based on Global Rank
     *      (if Global Rank crosses over TERM_AMPLIFIER_THRESHOLD)
     */
    function _calculateMaxTerm() private view returns (uint256) {
        if (globalRank > TERM_AMPLIFIER_THRESHOLD) {
            uint256 delta = globalRank.fromUInt().log_2().mul(TERM_AMPLIFIER.fromUInt()).toUInt();
            uint256 newMax = MAX_TERM_START + delta * SECONDS_IN_DAY;
            return Math.min(newMax, MAX_TERM_END);
        }
        return MAX_TERM_START;
    }

    /**
     * @dev calculates Withdrawal Penalty depending on lateness
     */
    function _penalty(uint256 secsLate) private pure returns (uint256) {
        // =MIN(2^(daysLate+3)/window-1,99)
        uint256 daysLate = secsLate / SECONDS_IN_DAY;
        if (daysLate > WITHDRAWAL_WINDOW_DAYS - 1) return MAX_PENALTY_PCT;
        uint256 penalty = (uint256(1) << (daysLate + 3)) / WITHDRAWAL_WINDOW_DAYS - 1;
        return Math.min(penalty, MAX_PENALTY_PCT);
    }

    /**
     * @dev calculates net Mint Reward (adjusted for Penalty)
     */
    function _calculateMintReward(
        uint256 cRank,
        uint256 term,
        uint256 maturityTs,
        uint256 amplifier,
        uint256 eeaRate
    ) private view returns (uint256) {
        uint256 secsLate = block.timestamp - maturityTs;
        uint256 penalty = _penalty(secsLate);
        uint256 rankDelta = Math.max(globalRank - cRank, 2);
        uint256 EAA = (1_000 + eeaRate);
        uint256 reward = getGrossReward(rankDelta, amplifier, term, EAA);
        return (reward * (100 - penalty)) / 100;
    }

    /**
     * @dev cleans up User Mint storage (gets some Gas credit;))
     */
    function _cleanUpUserMint() private {
        delete userMints[_msgSender()];
        activeMinters--;
    }

    /**
     * @dev calculates Stake Reward
     */
    function _calculateStakeReward(
        uint256 amount,
        uint256 term,
        uint256 maturityTs,
        uint256 apy
    ) private view returns (uint256) {
        if (block.timestamp > maturityTs) {
            uint256 rate = (apy * term * 1_000_000) / DAYS_IN_YEAR;
            return (amount * rate) / 100_000_000;
        }
        return 0;
    }

    /**
     * @dev calculates Reward Amplifier
     */
    function _calculateRewardAmplifier() private view returns (uint256) {
        uint256 amplifierDecrease = (block.timestamp - genesisTs) / SECONDS_IN_DAY;
        if (amplifierDecrease < REWARD_AMPLIFIER_START) {
            return Math.max(REWARD_AMPLIFIER_START - amplifierDecrease, REWARD_AMPLIFIER_END);
        } else {
            return REWARD_AMPLIFIER_END;
        }
    }

    /**
     * @dev calculates Early Adopter Amplifier Rate (in 1/000ths)
     *      actual EAA is (1_000 + EAAR) / 1_000
     */
    function _calculateEAARate() private view returns (uint256) {
        uint256 decrease = (EAA_PM_STEP * globalRank) / EAA_RANK_STEP;
        if (decrease > EAA_PM_START) return 0;
        return EAA_PM_START - decrease;
    }

    /**
     * @dev calculates APY (in %)
     */
    function _calculateAPY() private view returns (uint256) {
        uint256 decrease = (block.timestamp - genesisTs) / (SECONDS_IN_DAY * APY_DAYS_STEP);
        if (APY_START - APY_END < decrease) return APY_END;
        return APY_START - decrease;
    }

    /**
     * @dev creates User Stake
     */
    function _createStake(uint256 amount, uint256 term) private {
        userStakes[_msgSender()] = StakeInfo({
            term: term,
            maturityTs: block.timestamp + term * SECONDS_IN_DAY,
            amount: amount,
            apy: _calculateAPY()
        });
        activeStakes++;
        totalTokenStaked += amount;
    }

    // ==================== PUBLIC CONVENIENCE GETTERS (unchanged) ====================

    /**
     * @dev calculates gross Mint Reward
     */
    function getGrossReward(
        uint256 rankDelta,
        uint256 amplifier,
        uint256 term,
        uint256 eaa
    ) public pure returns (uint256) {
        int128 log128 = rankDelta.fromUInt().log_2();
        int128 reward128 = log128.mul(amplifier.fromUInt()).mul(term.fromUInt()).mul(eaa.fromUInt());
        return reward128.div(uint256(1_000).fromUInt()).toUInt();
    }

    /**
     * @dev returns User Mint object associated with User account address
     */
    function getUserMint() external view returns (MintInfo memory) {
        return userMints[_msgSender()];
    }

    /**
     * @dev returns Stake object associated with User account address
     */
    function getUserStake() external view returns (StakeInfo memory) {
        return userStakes[_msgSender()];
    }

    /**
     * @dev returns current AMP
     */
    function getCurrentAMP() external view returns (uint256) {
        return _calculateRewardAmplifier();
    }

    /**
     * @dev returns current EAA Rate
     */
    function getCurrentEAAR() external view returns (uint256) {
        return _calculateEAARate();
    }

    /**
     * @dev returns current APY
     */
    function getCurrentAPY() external view returns (uint256) {
        return _calculateAPY();
    }

    /**
     * @dev returns current MaxTerm
     */
    function getCurrentMaxTerm() external view returns (uint256) {
        return _calculateMaxTerm();
    }

    // ==================== PUBLIC STATE-CHANGING METHODS ====================

    /**
     * @dev accepts User cRank claim provided all checks pass
     *      (incl. no current claim exists)
     *
     *      CHANGED FROM XEN: payable; charges the per-address mint fee and
     *      notifies the vault on the genesis (first-ever) mint.
     */
    function claimRank(uint256 term) external payable nonReentrant {
        uint256 termSec = term * SECONDS_IN_DAY;
        require(termSec > MIN_TERM, "CRank: Term less than min");
        require(termSec < _calculateMaxTerm() + 1, "CRank: Term more than current max term");
        require(userMints[_msgSender()].rank == 0, "CRank: Mint already in progress");

        // start the vault's 1000-day genesis clock on the first mint (NEW)
        if (globalRank == GENESIS_RANK) {
            IMintVault(vault).notifyFirstMint();
        }

        // create and store new MintInfo
        MintInfo memory mintInfo = MintInfo({
            user: _msgSender(),
            term: term,
            maturityTs: block.timestamp + termSec,
            rank: globalRank,
            amplifier: _calculateRewardAmplifier(),
            eaaRate: _calculateEAARate()
        });
        userMints[_msgSender()] = mintInfo;
        activeMinters++;
        emit RankClaimed(_msgSender(), term, globalRank++);

        // Fee collection (and its refund, which hands control to msg.sender)
        // happens LAST, after every piece of state above is already final —
        // CHECKS-EFFECTS-INTERACTIONS. A reentrant call at this point sees
        // rank != 0 and is correctly blocked by the require() above. The
        // nonReentrant modifier is a second, independent backstop.
        _collectMintFee();
    }

    /**
     * @dev ends minting upon maturity (and within permitted Withdrawal Time
     *      Window), gets minted TOKEN
     *
     *      CHANGED: payable; claiming pays a discounted fee (25% of the
     *      mint fee), split 45/25/30 into the burn engines.
     */
    function claimMintReward() external payable nonReentrant {
        MintInfo memory mintInfo = userMints[_msgSender()];
        require(mintInfo.rank > 0, "CRank: No mint exists");
        require(block.timestamp > mintInfo.maturityTs, "CRank: Mint maturity not reached");

        // calculate reward and mint tokens
        uint256 rewardAmount = _calculateMintReward(
            mintInfo.rank,
            mintInfo.term,
            mintInfo.maturityTs,
            mintInfo.amplifier,
            mintInfo.eaaRate
        ) * 1 ether;
        _mint(_msgSender(), rewardAmount);

        _cleanUpUserMint();
        emit MintClaimed(_msgSender(), rewardAmount);

        // Fee collection (and its refund, which hands control to msg.sender
        // via a raw .call) happens LAST, after the mint record is already
        // deleted — CHECKS-EFFECTS-INTERACTIONS. Previously this ran FIRST,
        // meaning the refund could reenter claimMintReward() while the
        // mint was still marked active, minting the same reward repeatedly
        // in one transaction. Found via community testing; nonReentrant
        // below is a second, independent backstop.
        _collectClaimFee();
    }

    /**
     * @dev  ends minting upon maturity (and within permitted Withdrawal time
     *       Window); mints TOKEN and splits it between User and designated
     *       other address (unchanged from XEN)
     */
    function claimMintRewardAndShare(address other, uint256 pct) external payable nonReentrant {
        MintInfo memory mintInfo = userMints[_msgSender()];
        require(other != address(0), "CRank: Cannot share with zero address");
        require(pct > 0, "CRank: Cannot share zero percent");
        require(pct < 101, "CRank: Cannot share 100+ percent");
        require(mintInfo.rank > 0, "CRank: No mint exists");
        require(block.timestamp > mintInfo.maturityTs, "CRank: Mint maturity not reached");

        // calculate reward
        uint256 rewardAmount = _calculateMintReward(
            mintInfo.rank,
            mintInfo.term,
            mintInfo.maturityTs,
            mintInfo.amplifier,
            mintInfo.eaaRate
        ) * 1 ether;
        uint256 sharedReward = (rewardAmount * pct) / 100;
        uint256 ownReward = rewardAmount - sharedReward;

        // mint reward tokens
        _mint(_msgSender(), ownReward);
        _mint(other, sharedReward);

        _cleanUpUserMint();
        emit MintClaimed(_msgSender(), rewardAmount);

        // fee collection last — see claimMintReward for why
        _collectClaimFee();
    }

    /**
     * @dev  ends minting upon maturity (and within permitted Withdrawal time
     *       Window); mints TOKEN and stakes 'pct' of it for 'term'
     *       (unchanged from XEN)
     */
    function claimMintRewardAndStake(uint256 pct, uint256 term) external payable nonReentrant {
        MintInfo memory mintInfo = userMints[_msgSender()];
        require(pct < 101, "CRank: Cannot share >100 percent");
        require(mintInfo.rank > 0, "CRank: No mint exists");
        require(block.timestamp > mintInfo.maturityTs, "CRank: Mint maturity not reached");

        // calculate reward
        uint256 rewardAmount = _calculateMintReward(
            mintInfo.rank,
            mintInfo.term,
            mintInfo.maturityTs,
            mintInfo.amplifier,
            mintInfo.eaaRate
        ) * 1 ether;
        uint256 stakedReward = (rewardAmount * pct) / 100;
        uint256 ownReward = rewardAmount - stakedReward;

        // mint reward tokens part
        _mint(_msgSender(), ownReward);
        _cleanUpUserMint();
        emit MintClaimed(_msgSender(), rewardAmount);

        // stake extra tokens part
        require(stakedReward > MIN_STAKE, "TOKEN: Below min stake");
        require(term * SECONDS_IN_DAY > MIN_TERM, "TOKEN: Below min stake term");
        require(term * SECONDS_IN_DAY < MAX_TERM_END + 1, "TOKEN: Above max stake term");
        require(userStakes[_msgSender()].amount == 0, "TOKEN: stake exists");

        _createStake(stakedReward, term);
        emit Staked(_msgSender(), stakedReward, term);

        // fee collection last, after every piece of state above (mint
        // cleanup AND the new stake) is already final — see claimMintReward
        _collectClaimFee();
    }

    /**
     * @dev initiates TOKEN Stake in amount for a term (days)
     *      (unchanged from XEN)
     */
    function stake(uint256 amount, uint256 term) external nonReentrant {
        require(balanceOf(_msgSender()) >= amount, "TOKEN: not enough balance");
        require(amount > MIN_STAKE, "TOKEN: Below min stake");
        require(term * SECONDS_IN_DAY > MIN_TERM, "TOKEN: Below min stake term");
        require(term * SECONDS_IN_DAY < MAX_TERM_END + 1, "TOKEN: Above max stake term");
        require(userStakes[_msgSender()].amount == 0, "TOKEN: stake exists");

        // burn staked TOKEN
        _burn(_msgSender(), amount);
        // create Stake
        _createStake(amount, term);
        emit Staked(_msgSender(), amount, term);
    }

    /**
     * @dev ends Stake and gets reward if the Stake is mature
     *      (unchanged from XEN)
     */
    function withdraw() external nonReentrant {
        StakeInfo memory userStake = userStakes[_msgSender()];
        require(userStake.amount > 0, "TOKEN: no stake exists");

        uint256 stakeReward = _calculateStakeReward(
            userStake.amount,
            userStake.term,
            userStake.maturityTs,
            userStake.apy
        );
        activeStakes--;
        totalTokenStaked -= userStake.amount;

        // mint staked TOKEN (+ reward)
        _mint(_msgSender(), userStake.amount + stakeReward);
        emit Withdrawn(_msgSender(), userStake.amount, stakeReward);
        delete userStakes[_msgSender()];
    }

    /**
     * @dev burns TOKEN and creates Proof-Of-Burn record to be used by
     *      connected DeFi services (unchanged from XEN)
     */
    function burn(address user, uint256 amount) public {
        require(amount > MIN_BURN, "Burn: Below min limit");
        require(
            IERC165(_msgSender()).supportsInterface(type(IBurnRedeemable).interfaceId),
            "Burn: not a supported contract"
        );

        _spendAllowance(user, _msgSender(), amount);
        _burn(user, amount);
        userBurns[user] += amount;
        IBurnRedeemable(_msgSender()).onTokenBurned(user, amount);
    }
}