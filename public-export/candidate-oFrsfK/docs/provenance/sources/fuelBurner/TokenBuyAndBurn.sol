// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/* === UNIV3 === */
import {TransferHelper} from "./library/TransferHelper.sol";
import {INonfungiblePositionManager} from "./interfaces/INonfungiblePositionManager.sol";
import {TickMath} from "https://github.com/Uniswap/v3-core/blob/0.8/contracts/libraries/TickMath.sol";
import {OracleLibrary} from "./library/OracleLibrary.sol";
import {IV3SwapRouter} from "./interfaces/IV3SwapRouter.sol";

/* === OZ === */
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC165} from "@openzeppelin/contracts/interfaces/IERC165.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

/* === CONST === */
import "./const/TokenConst.sol";

/* === SYSTEM === */
import {Token} from "./Token.sol";
import {IBurnRedeemable} from "./interfaces/IBurnRedeemable.sol";

interface IWETH {
    function deposit() external payable;
    function approve(address spender, uint256 amount) external returns (bool);
}

/**
 * @title  TokenBuyAndBurn
 * @notice Fork of LessBuyAndProcess, surgically reduced for this protocol:
 *
 *         REMOVED vs the LESS original:
 *           - Pump fund (28%/1-year timelock): the 1000-day MintVault is the
 *             protocol's only timelock, so 100% of every deposit goes
 *             straight into the drip pool.
 *           - All MORE-denominated flows: deposits here are ETH only
 *             (25% of mint fees immediately + vault sweeps every 1000 days).
 *           - The build (liquidity-adding) flow: nothing in this protocol
 *             feeds it.
 *
 *         CHANGED vs the LESS original:
 *           - TOKEN pairs with WETH, not MORE. The burn path is a single
 *             hop: ETH -> TOKEN, TWAP-guarded by this protocol's own
 *             TOKEN/WETH pool.
 *           - Pool creation explicitly calls
 *             createAndInitializePoolIfNecessary (the original assumed the
 *             pool existed; this fork cannot, since nothing else creates it).
 *
 *         UNCHANGED vs the LESS original:
 *           - 10-minute intervals, 144/day, default 1%/day allocation
 *             (owner-adjustable 1-10%).
 *           - 1.5% keeper incentive per executed interval.
 *           - TWAP-guarded swaps with owner-adjustable slippage (2-100).
 *           - LP fee collection: TOKEN side burned, WETH side to genesis.
 */
contract TokenBuyAndBurn is ReentrancyGuard, Ownable2Step, IERC721Receiver, IBurnRedeemable {
    INonfungiblePositionManager public constant POSITION_MANAGER =
        INonfungiblePositionManager(UNISWAP_V3_POSITION_MANAGER);

    Token public immutable token;
    uint32 public immutable startTimeStamp;

    /* ================================================================
                               BURN VARIABLES
       ================================================================ */

    struct IntervalBurn {
        uint128 amountAllocated;
        uint128 amountBurned;
    }

    struct LP {
        uint248 tokenId;
        bool isWethToken0;
    }

    LP public lpToken;

    /// @notice TOKEN/WETH V3 pool created by this contract; TWAP source.
    address public tokenWethPool;

    bool public liquidityAdded;

    uint256 public totalTokenBurnt;
    uint256 public ethUsedForBurns;

    /// @notice ETH awaiting drip-burning.
    uint256 public totalETHBurn;

    /// @notice Daily drip in basis points of the pool balance (100 = 1%).
    uint256 public DAILY_ALLOCATION_ETH_BURNING = 100;

    mapping(uint32 => IntervalBurn) public ethIntervalsBurn;
    uint32 public lastETHBurnIntervalNumber;
    uint32 public lastBurnedETHIntervalStartTimestamp;

    uint8 public ethToTokenSlippage = 10;
    uint8 public liquiditySlippage = 10;

    /* ================================================================
                                 MODIFIERS
       ================================================================ */

    modifier burnETHIntervalUpdate() {
        _intervalUpdateETHForBurning();
        _;
    }

    /* ================================================================
                                   EVENTS
       ================================================================ */

    event BuyAndBurn(uint256 indexed ethAmount, uint256 indexed tokenBurnt, address indexed caller);
    event TokenBurned(uint256 indexed tokenBurnt);
    event LiquidityAdded(uint256 wethAmount, uint256 tokenAmount, uint256 tokenId);
    event DailyAllocationETHBurningUpdated(uint256 newDailyAllocation);
    event ETHToTokenSlippageUpdated(uint8 newSlippage);
    event LiquiditySlippageUpdated(uint8 newSlippage);

    /* ================================================================
                                   ERRORS
       ================================================================ */

    error NotStartedYet();
    error InvalidInput();
    error DeadlinePassed();
    error NotEnoughETHForLiquidity();
    error LiquidityAlreadyAdded();
    error IntervalAlreadyBurned();

    /* ================================================================
                                 CONSTRUCTOR
       ================================================================ */

    constructor(address _token, uint32 _startTimestamp, address _owner) Ownable(_owner) {
        token = Token(_token);

        // 0 = start now. Non-zero values more than 30 days out are rejected
        // (added after a testnet deploy pasted a far-future deadline here).
        uint32 start = _startTimestamp == 0 ? uint32(block.timestamp) : _startTimestamp;
        if (start > block.timestamp + 30 days) revert InvalidInput();

        startTimeStamp = start;
        lastBurnedETHIntervalStartTimestamp = start;

        // Self-allowance so token.burn(address(this), x) can spend our
        // balance (XEN's burn() pulls via allowance even from self).
        token.approve(address(this), type(uint256).max);

        // Stake the pool's starting price NOW, atomically with this
        // contract's own deployment — before any public transaction against
        // it is even possible. Setting a Uniswap V3 pool's initial price is
        // a one-time, permanent action and moves zero tokens; whoever calls
        // it first wins, permanently, with no way to later correct it. Left
        // until the liquidity-seeding step (which only fires once real fees
        // have accumulated, potentially hours or days after deployment),
        // this address is public and computable the moment the Token
        // contract deploys — an attacker (or an automated sniping bot; this
        // is a known, common pattern) could claim it first, for the cost of
        // gas alone, and every dollar of the protocol's own future
        // liquidity would then be deposited at THEIR price. Doing it here
        // shrinks that window to the gap between Token deploying and this
        // contract deploying — the tightest this manual deploy flow allows.
        // Found via community testing — thank you.
        (uint256 amount0, uint256 amount1, address token0, address token1) =
            _sortAmounts(INITIAL_WETH_FOR_LIQ, INITIAL_LP_MINT);
        uint160 sqrtPriceX96 = _sqrtPriceX96(amount0, amount1);
        tokenWethPool = POSITION_MANAGER.createAndInitializePoolIfNecessary(
            token0,
            token1,
            POOL_FEE,
            sqrtPriceX96
        );
    }

    /// @notice Any plain ETH transfer is credited exactly like
    ///         distributeETHForBurning() — there is no way to send ETH to
    ///         this contract that becomes stuck outside the burn accounting.
    ///         (Previously a bare no-op: ETH sent here directly increased
    ///         the contract's balance but never totalETHBurn, so it sat
    ///         permanently invisible to every burn calculation, which reads
    ///         totalETHBurn rather than address(this).balance. Found via
    ///         community testing — thank you.)
    receive() external payable {
        if (msg.value == 0) return; // harmless no-op for a zero-value probe
        _creditETHForBurning(msg.value);
    }

    /* ================================================================
                               DEPOSIT (ETH IN)
       ================================================================ */

    /**
     * @notice Entry point for the FeeDistributor's 25% leg and the
     *         MintVault's 1000-day sweeps. 100% of the deposit joins the
     *         drip pool (pump fund removed vs the LESS original).
     */
    function distributeETHForBurning() external payable {
        if (msg.value == 0) revert InvalidInput();
        _creditETHForBurning(msg.value);
    }

    function _creditETHForBurning(uint256 amount) private {
        // Deposits only ever grow the pool. They used to also conditionally
        // trigger _intervalUpdateETHForBurning() here — but if two deposits
        // landed before anyone actually called swapETHForTokenAndBurn, the
        // first deposit would correctly close out the stacked interval into
        // a pending record, and the SECOND deposit would then close out a
        // NEW interval and move the tracking pointer past it — permanently
        // orphaning the first record. The underlying ETH wasn't lost (it's
        // only subtracted from totalETHBurn on an actual swap), but that
        // specific stacked interval, and its burn event, could never fire.
        // Interval bookkeeping is now advanced ONLY by the swap function's
        // own modifier, exactly when it's actually needed. Found via
        // community testing.
        totalETHBurn += amount;
    }

    /* ================================================================
                             BURN (keeper entry)
       ================================================================ */

    /**
     * @notice Swaps the current interval's ETH allocation for TOKEN and
     *         burns it. Permissionless; caller earns INCENTIVE_FEE (1.5%).
     */
    function swapETHForTokenAndBurn(uint32 _deadline) external nonReentrant burnETHIntervalUpdate {
        if (!liquidityAdded) revert NotStartedYet();

        IntervalBurn storage currInterval = ethIntervalsBurn[lastETHBurnIntervalNumber];
        if (currInterval.amountBurned != 0) revert IntervalAlreadyBurned();

        uint256 amountAllocated = currInterval.amountAllocated;
        currInterval.amountBurned = currInterval.amountAllocated;

        uint256 incentive = (amountAllocated * INCENTIVE_FEE) / BPS_DENOM;
        uint256 ethToSwapAndBurn = amountAllocated - incentive;

        uint256 tokenAmount = _swapETHForToken(ethToSwapAndBurn, _deadline);

        ethUsedForBurns += ethToSwapAndBurn;
        totalETHBurn -= amountAllocated;

        burnToken();

        (bool success, ) = payable(msg.sender).call{value: incentive, gas: 30000}("");
        require(success, "Transfer failed");

        emit BuyAndBurn(ethToSwapAndBurn, tokenAmount, msg.sender);
    }

    /**
     * @notice Burns all TOKEN held by this contract through the token's
     *         proof-of-burn mechanism.
     */
    function burnToken() public {
        uint256 tokenToBurn = token.balanceOf(address(this));
        if (tokenToBurn == 0) return;
        totalTokenBurnt += tokenToBurn;
        token.burn(address(this), tokenToBurn);

        emit TokenBurned(tokenToBurn);
    }

    /// @dev IBurnRedeemable hook required by Token.burn(); no-op.
    function onTokenBurned(address, uint256) external {}

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == type(IBurnRedeemable).interfaceId ||
            interfaceId == type(IERC165).interfaceId;
    }

    /* ================================================================
                       POOL CREATION + INITIAL LIQUIDITY
       ================================================================ */

    /**
     * @notice Seeds the already-initialized TOKEN/WETH 1% pool (its price
     *         was staked atomically at deployment, in the constructor) with
     *         INITIAL_WETH_FOR_LIQ (from accumulated deposits) against
     *         INITIAL_LP_MINT freshly minted TOKEN. Permissionless once
     *         enough ETH has accumulated.
     */
    function addLiquidityToTokenWethPool(uint32 _deadline) external nonReentrant {
        if (liquidityAdded) revert LiquidityAlreadyAdded();
        if (totalETHBurn < INITIAL_WETH_FOR_LIQ) revert NotEnoughETHForLiquidity();

        liquidityAdded = true;

        token.mintTokensForLP();
        IWETH(WETH_ADDRESS).deposit{value: INITIAL_WETH_FOR_LIQ}();

        (uint256 amount0, uint256 amount1, address token0, address token1) =
            _sortAmounts(INITIAL_WETH_FOR_LIQ, INITIAL_LP_MINT);
        // tokenWethPool was already created + initialized in the constructor;
        // no need to touch price here, just deposit liquidity into it.

        TransferHelper.safeApprove(token0, address(POSITION_MANAGER), amount0);
        TransferHelper.safeApprove(token1, address(POSITION_MANAGER), amount1);

        uint256 amount0Min = (amount0 * (100 - liquiditySlippage)) / 100;
        uint256 amount1Min = (amount1 * (100 - liquiditySlippage)) / 100;

        INonfungiblePositionManager.MintParams memory params =
            INonfungiblePositionManager.MintParams({
                token0:         token0,
                token1:         token1,
                fee:            POOL_FEE,
                tickLower:      (TickMath.MIN_TICK / TICK_SPACING) * TICK_SPACING,
                tickUpper:      (TickMath.MAX_TICK / TICK_SPACING) * TICK_SPACING,
                amount0Desired: amount0,
                amount1Desired: amount1,
                amount0Min:     amount0Min,
                amount1Min:     amount1Min,
                recipient:      address(this),
                deadline:       _deadline
            });

        (uint256 tokenId, , uint256 used0, uint256 used1) = POSITION_MANAGER.mint(params);

        if (amount0 > used0) {
            TransferHelper.safeTransfer(token0, GENESIS_WALLET, amount0 - used0);
        }
        if (amount1 > used1) {
            TransferHelper.safeTransfer(token1, GENESIS_WALLET, amount1 - used1);
        }

        TransferHelper.safeApprove(token0, address(POSITION_MANAGER), 0);
        TransferHelper.safeApprove(token1, address(POSITION_MANAGER), 0);

        lpToken = LP({tokenId: uint248(tokenId), isWethToken0: token0 == WETH_ADDRESS});

        totalETHBurn -= INITIAL_WETH_FOR_LIQ;

        emit LiquidityAdded(INITIAL_WETH_FOR_LIQ, INITIAL_LP_MINT, tokenId);
    }

    /**
     * @notice Collects accrued LP fees: TOKEN side is burned, WETH side is
     *         sent to the genesis wallet (mirrors the LESS original, where
     *         the non-native side went to genesis).
     */
    function burnFees() external nonReentrant returns (uint256 amount0, uint256 amount1) {
        LP memory _lp = lpToken;
        INonfungiblePositionManager.CollectParams memory params =
            INonfungiblePositionManager.CollectParams({
                tokenId: _lp.tokenId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            });
        (amount0, amount1) = POSITION_MANAGER.collect(params);
        (uint256 wethAmount, ) = _lp.isWethToken0 ? (amount0, amount1) : (amount1, amount0);

        if (wethAmount > 0) {
            TransferHelper.safeTransfer(WETH_ADDRESS, GENESIS_WALLET, wethAmount);
        }

        if (token.balanceOf(address(this)) > 0) {
            burnToken();
        }
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

    function setSlippageForETHToToken(uint8 _newSlippage) external onlyOwner {
        if (_newSlippage > 100 || _newSlippage < 2) revert InvalidInput();
        ethToTokenSlippage = _newSlippage;

        emit ETHToTokenSlippageUpdated(_newSlippage);
    }

    function setLiquiditySlippage(uint8 _newSlippage) external onlyOwner {
        if (_newSlippage > 100 || _newSlippage < 2) revert InvalidInput();
        liquiditySlippage = _newSlippage;

        emit LiquiditySlippageUpdated(_newSlippage);
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
                            INTERNAL: SWAP + MATH
       ================================================================ */

    /// @dev Single hop ETH -> TOKEN (CHANGED vs LESS's two-hop ETH->MORE->LESS).
    function _swapETHForToken(
        uint256 ethAmount,
        uint256 _deadline
    ) internal returns (uint256 tokenReceived) {
        bytes memory path = abi.encodePacked(WETH_ADDRESS, POOL_FEE, address(token));
        uint256 expectedTokenAmount = getTokenQuoteForETH(ethAmount);
        uint256 adjustedTokenAmount = (expectedTokenAmount * (100 - ethToTokenSlippage)) / 100;
        // SwapRouter02 has no deadline param; enforce it here instead.
        if (block.timestamp > _deadline) revert DeadlinePassed();

        IV3SwapRouter.ExactInputParams memory params = IV3SwapRouter.ExactInputParams({
            path: path,
            recipient: address(this),
            amountIn: ethAmount,
            amountOutMinimum: adjustedTokenAmount
        });

        return IV3SwapRouter(UNISWAP_V3_ROUTER).exactInput{value: ethAmount}(params);
    }

    function _sortAmounts(
        uint256 wethAmount,
        uint256 tokenAmount
    )
        internal
        view
        returns (uint256 amount0, uint256 amount1, address token0, address token1)
    {
        address _weth = WETH_ADDRESS;
        address _token = address(token);
        (token0, token1) = _weth < _token ? (_weth, _token) : (_token, _weth);
        (amount0, amount1) = token0 == _weth ? (wethAmount, tokenAmount) : (tokenAmount, wethAmount);
    }

    /// @dev sqrtPriceX96 = sqrt(amount1/amount0) * 2^96, via Babylonian sqrt
    ///      of the 192-bit-shifted ratio.
    function _sqrtPriceX96(uint256 amount0, uint256 amount1) internal pure returns (uint160) {
        // ratioX192 = amount1 * 2^192 / amount0, staged as two 96-bit shifts
        // to keep the intermediate within uint256 for our seed magnitudes.
        uint256 ratioX192 = (((amount1 << 96) / amount0) << 96);
        return uint160(_sqrt(ratioX192));
    }

    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }

    /* ================================================================
                               PUBLIC GETTERS
       ================================================================ */

    /// @notice 15-minute TWAP quote of TOKEN out for `baseAmount` of WETH in,
    ///         read from this protocol's own TOKEN/WETH pool.
    function getTokenQuoteForETH(uint256 baseAmount) public view returns (uint256 quote) {
        address poolAddress = tokenWethPool;
        uint32 secondsAgo = 15 * 60;
        uint32 oldestObservation = OracleLibrary.getOldestObservationSecondsAgo(poolAddress);
        if (oldestObservation < secondsAgo) secondsAgo = oldestObservation;
        (int24 arithmeticMeanTick, ) = OracleLibrary.consult(poolAddress, secondsAgo);
        uint160 sqrtPriceX96 = TickMath.getSqrtRatioAtTick(arithmeticMeanTick);
        quote = OracleLibrary.getQuoteForSqrtRatioX96(
            sqrtPriceX96,
            baseAmount,
            WETH_ADDRESS,
            address(token)
        );
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}