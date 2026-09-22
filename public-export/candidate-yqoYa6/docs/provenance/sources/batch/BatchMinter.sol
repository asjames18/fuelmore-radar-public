// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface ITokenMintable {
    function claimRank(uint256 term) external payable;
    function claimMintReward() external payable;
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function soloMintGas() external view returns (uint256);
    function effectiveGasPrice(uint256 gasPrice) external view returns (uint256);
    function claimFee(uint256 gasPrice) external view returns (uint256);
}

/**
 * @title  MintProxy
 * @notice Minimal implementation behind every EIP-1167 clone. Each clone is
 *         one "address" holding one mint slot on the Token contract.
 *         Callable only by the BatchMinter that deployed it.
 */
contract MintProxy {
    address public immutable factory;

    error OnlyFactory();

    constructor() {
        factory = msg.sender;
    }

    /// @dev Refund path safety: Token.claimRank refunds overpayment to the
    ///      caller (this proxy). The factory sends exact fees so this should
    ///      stay empty, but sweep-ability is preserved via claimReward's
    ///      ETH forwarding below.
    receive() external payable {}

    function proxyClaimRank(ITokenMintable token, uint256 term) external payable {
        if (msg.sender != factory) revert OnlyFactory();
        token.claimRank{value: msg.value}(term);
    }

    /// @notice Claims the matured mint (paying the claim fee) and forwards
    ///         all TOKEN (and any stray ETH) to `to`.
    function proxyClaimReward(ITokenMintable token, address to) external payable {
        if (msg.sender != factory) revert OnlyFactory();
        token.claimMintReward{value: msg.value}();
        token.transfer(to, token.balanceOf(address(this)));
        uint256 bal = address(this).balance;
        if (bal > 0) {
            (bool ok, ) = to.call{value: bal}("");
            require(ok, "ETH sweep failed");
        }
    }

    /// @notice Claims the matured mint AND immediately starts a new one —
    ///         two fees, one transaction, perpetual burn fuel. The claim leg
    ///         and the new-mint leg pay their own (different) fee amounts.
    function proxyClaimAndRemint(
        ITokenMintable token,
        address to,
        uint256 term,
        uint256 claimFeeAmt,
        uint256 mintFeeAmt
    ) external payable {
        if (msg.sender != factory) revert OnlyFactory();
        token.claimMintReward{value: claimFeeAmt}();
        token.transfer(to, token.balanceOf(address(this)));
        token.claimRank{value: mintFeeAmt}(term);
    }
}

/**
 * @title  BatchMinter
 * @notice CoinTool-style batch minting. One wallet can start many mints in a
 *         single transaction; each mint lives at a deterministic minimal
 *         proxy address owned (logically) by the caller.
 *
 *         FEE MODEL — THE BATCHER PENALTY:
 *         Every proxy pays the FULL per-address fee inside
 *         Token.claimRank(): soloMintGas * max(tx.gasprice, minGasPrice).
 *         Batching amortizes real gas, but the fee never amortizes: 10 mints
 *         = 10 full fees, first mint or remint alike. This is deliberate;
 *         the whale discount on gas is clawed back into the buy-and-burn.
 *
 *         Proxies are CREATE2-deterministic per (user, index), so index N
 *         is reusable forever for remints once its previous mint is claimed.
 */
contract BatchMinter is ReentrancyGuard {
    using Clones for address;

    ITokenMintable public immutable token;
    address public immutable implementation;

    /// @dev Hard cap per tx so a full batch cannot exceed the block gas limit.
    uint256 public constant MAX_BATCH = 100;

    /// @notice Highest index+1 ever used per user (informational, for UIs).
    mapping(address => uint256) public proxiesOf;

    event BatchRankClaimed(address indexed user, uint256 startIndex, uint256 count, uint256 term, uint256 feePaid);
    event BatchRewardClaimed(address indexed user, uint256 startIndex, uint256 count);
    event BatchClaimedAndReminted(address indexed user, uint256 startIndex, uint256 count, uint256 newTerm);

    error InvalidCount();
    error InsufficientFee(uint256 required, uint256 provided);
    error ProxyDoesNotExist(uint256 index);
    error RefundFailed();

    constructor(address _token) {
        token = ITokenMintable(_token);
        implementation = address(new MintProxy());
    }

    /* ================================================================
                                   VIEWS
       ================================================================ */

    /// @notice Deterministic proxy address for (user, index).
    function proxyAddress(address user, uint256 index) public view returns (address) {
        bytes32 salt = keccak256(abi.encodePacked(user, index));
        return implementation.predictDeterministicAddress(salt, address(this));
    }

    /// @notice Total fee required to start `count` mints at gas price
    ///         `gasPrice` (frontend helper).
    function batchFee(uint256 count, uint256 gasPrice) external view returns (uint256) {
        return token.soloMintGas() * token.effectiveGasPrice(gasPrice) * count;
    }

    /// @notice Total fee required to claim `count` matured mints at gas
    ///         price `gasPrice` — 25% of the equivalent mint fee (frontend helper).
    function batchClaimFee(uint256 count, uint256 gasPrice) external view returns (uint256) {
        return token.claimFee(gasPrice) * count;
    }

    /* ================================================================
                             BATCH: START MINTS
       ================================================================ */

    /**
     * @notice Starts `count` mints of `term` days at proxy indices
     *         [startIndex, startIndex + count). Deploys proxies on first
     *         use of an index; reuses them for remints. Reverts if any
     *         index has a mint already in progress.
     */
    function batchClaimRank(
        uint256 startIndex,
        uint256 count,
        uint256 term
    ) external payable nonReentrant {
        if (count == 0 || count > MAX_BATCH) revert InvalidCount();

        uint256 feePerMint = token.soloMintGas() * token.effectiveGasPrice(tx.gasprice);
        uint256 totalFee = feePerMint * count;
        if (msg.value < totalFee) revert InsufficientFee(totalFee, msg.value);

        for (uint256 i = startIndex; i < startIndex + count; i++) {
            bytes32 salt = keccak256(abi.encodePacked(msg.sender, i));
            address proxy = implementation.predictDeterministicAddress(salt, address(this));
            if (proxy.code.length == 0) {
                implementation.cloneDeterministic(salt);
            }
            MintProxy(payable(proxy)).proxyClaimRank{value: feePerMint}(token, term);
        }

        if (startIndex + count > proxiesOf[msg.sender]) {
            proxiesOf[msg.sender] = startIndex + count;
        }

        uint256 refund = msg.value - totalFee;
        if (refund > 0) {
            (bool ok, ) = msg.sender.call{value: refund}("");
            if (!ok) revert RefundFailed();
        }

        emit BatchRankClaimed(msg.sender, startIndex, count, term, totalFee);
    }

    /* ================================================================
                            BATCH: CLAIM REWARDS
       ================================================================ */

    /**
     * @notice Claims matured mints at proxy indices
     *         [startIndex, startIndex + count); all TOKEN goes to the
     *         caller. Each claim pays the per-address protocol fee.
     */
    function batchClaimReward(uint256 startIndex, uint256 count) external payable nonReentrant {
        if (count == 0 || count > MAX_BATCH) revert InvalidCount();

        uint256 feePerClaim = token.claimFee(tx.gasprice);
        uint256 totalFee = feePerClaim * count;
        if (msg.value < totalFee) revert InsufficientFee(totalFee, msg.value);

        for (uint256 i = startIndex; i < startIndex + count; i++) {
            bytes32 salt = keccak256(abi.encodePacked(msg.sender, i));
            address proxy = implementation.predictDeterministicAddress(salt, address(this));
            // proxyClaimReward is void-returning, so Solidity does NOT
            // auto-check that `proxy` actually has code before calling it —
            // that check only gets inserted for non-void return types. Without
            // this explicit check, calling a never-minted index would silently
            // no-op (EVM treats a call to an empty address as a harmless value
            // transfer), stranding the caller's fee at that address forever
            // while BatchRewardClaimed still fires as if it worked. Found via
            // community testing.
            if (proxy.code.length == 0) revert ProxyDoesNotExist(i);
            MintProxy(payable(proxy)).proxyClaimReward{value: feePerClaim}(token, msg.sender);
        }

        _refund(msg.value - totalFee);
        emit BatchRewardClaimed(msg.sender, startIndex, count);
    }

    /**
     * @notice CoinTool-style Claim & Remint: claims matured mints and
     *         immediately starts fresh mints of `newTerm` days at the same
     *         proxy indices — one transaction, two fees per mint, and the
     *         burn engines get fed on both ends of every cycle.
     */
    function batchClaimAndRemint(
        uint256 startIndex,
        uint256 count,
        uint256 newTerm
    ) external payable nonReentrant {
        if (count == 0 || count > MAX_BATCH) revert InvalidCount();

        uint256 claimFeeEach = token.claimFee(tx.gasprice);
        uint256 mintFeeEach = token.soloMintGas() * token.effectiveGasPrice(tx.gasprice);
        uint256 feeEach = claimFeeEach + mintFeeEach;
        uint256 totalFee = feeEach * count;
        if (msg.value < totalFee) revert InsufficientFee(totalFee, msg.value);

        for (uint256 i = startIndex; i < startIndex + count; i++) {
            bytes32 salt = keccak256(abi.encodePacked(msg.sender, i));
            address proxy = implementation.predictDeterministicAddress(salt, address(this));
            // Same gap as batchClaimReward — see the comment there.
            if (proxy.code.length == 0) revert ProxyDoesNotExist(i);
            MintProxy(payable(proxy)).proxyClaimAndRemint{value: feeEach}(
                token, msg.sender, newTerm, claimFeeEach, mintFeeEach
            );
        }

        _refund(msg.value - totalFee);
        emit BatchClaimedAndReminted(msg.sender, startIndex, count, newTerm);
    }

    function _refund(uint256 amount) private {
        if (amount > 0) {
            (bool ok, ) = msg.sender.call{value: amount}("");
            if (!ok) revert RefundFailed();
        }
    }
}