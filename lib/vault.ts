/**
 * lib/vault.ts
 * Browser-compatible vault interaction functions.
 * Mirrors the logic in scripts/*.js but uses the connected wallet adapter
 * instead of a Keypair loaded from a private key.
 */

import {
  Connection,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Keypair,
  Transaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  BaseFeeMode,
  DammV2BaseFeeMode,
  DynamicBondingCurveClient,
  buildCurve,
  getMigratedPoolMarketCapFeeSchedulerParams,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
  getMint,
} from "@solana/spl-token";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import DEVNET_IDL from "../idl/staking_vault.json";
import MAINNET_IDL from "../idl/mainnet.json";

// ─── Network Config ──────────────────────────────────────────────────────────

type Network = "devnet" | "mainnet";

interface NetworkConfig {
  idl: typeof DEVNET_IDL;
  programId: PublicKey;
  deployerAddress: PublicKey;
}

const NETWORK_CONFIGS: Record<Network, NetworkConfig> = {
  devnet: {
    idl: DEVNET_IDL,
    programId: new PublicKey((DEVNET_IDL as { address: string }).address),
    deployerAddress: new PublicKey("cyaibXfQvCC4qKDYNguU4mXryhKjSkszPWkd56KFkrF"),
  },
  mainnet: {
    idl: MAINNET_IDL,
    programId: new PublicKey((MAINNET_IDL as { address: string }).address),
    deployerAddress: new PublicKey("57QCuZrNChaLZd7Rjs9zWQocrhQosWtuabkygQLzvEP4"),
  },
};

function getConfig(network: Network = "devnet"): NetworkConfig {
  return NETWORK_CONFIGS[network];
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** @deprecated Use getConfig(network).deployerAddress instead */
export const DEPLOYER_ADDRESS = NETWORK_CONFIGS.devnet.deployerAddress;
const NATIVE_MINT_ADDRESS = "So11111111111111111111111111111111111111112";

export const DBC_PROGRAM_ID = new PublicKey(
  "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
);

// ─── PDA Utilities ───────────────────────────────────────────────────────────

export function getGlobalStatePda(network: Network = "devnet"): PublicKey {
  console.log("[vault] getGlobalStatePda()", { network });
  const cfg = getConfig(network);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("staking_vault"), cfg.deployerAddress.toBuffer()],
    cfg.programId,
  );
  return pda;
}

export function getCampaignPda(campaignId: number | BN, network: Network = "devnet"): PublicKey {
  console.log("[vault] getCampaignPda()", { campaignId, network });
  const cfg = getConfig(network);
  const idBn = BN.isBN(campaignId) ? campaignId : new BN(campaignId);
  const campaignIdBuf = idBn.toArrayLike(Buffer, "le", 8);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("campaign"), cfg.deployerAddress.toBuffer(), campaignIdBuf],
    cfg.programId,
  );
  return pda;
}

export function getUserDepositPda(
  campaignPda: PublicKey,
  userPubkey: PublicKey,
  network: Network = "devnet",
): PublicKey {
  console.log("[vault] getUserDepositPda()", {
    campaignPda: campaignPda.toBase58(),
    userPubkey: userPubkey.toBase58(),
    network,
  });
  const cfg = getConfig(network);
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("user_deposit"),
      campaignPda.toBuffer(),
      userPubkey.toBuffer(),
    ],
    cfg.programId,
  );
  return pda;
}

export function getClaimPda(campaignPda: PublicKey, network: Network = "devnet"): PublicKey {
  console.log("[vault] getClaimPda()", { campaignPda: campaignPda.toBase58(), network });
  const cfg = getConfig(network);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("claim"), campaignPda.toBuffer()],
    cfg.programId,
  );
  return pda;
}

export function derivePoolPdas(
  configPk: PublicKey,
  baseMint: PublicKey,
  quoteMint: PublicKey,
) {
  console.log("[vault] derivePoolPdas()", {
    configPk: configPk.toBase58(),
    baseMint: baseMint.toBase58(),
    quoteMint: quoteMint.toBase58(),
  });
  const cmp = Buffer.compare(baseMint.toBuffer(), quoteMint.toBuffer());
  const maxKey = cmp > 0 ? baseMint : quoteMint;
  const minKey = cmp > 0 ? quoteMint : baseMint;

  const [poolPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("pool"),
      configPk.toBuffer(),
      maxKey.toBuffer(),
      minKey.toBuffer(),
    ],
    DBC_PROGRAM_ID,
  );
  const [baseVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_vault"), baseMint.toBuffer(), poolPda.toBuffer()],
    DBC_PROGRAM_ID,
  );
  const [quoteVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_vault"), quoteMint.toBuffer(), poolPda.toBuffer()],
    DBC_PROGRAM_ID,
  );
  const [poolAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_authority")],
    DBC_PROGRAM_ID,
  );
  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    DBC_PROGRAM_ID,
  );
  return {
    poolPda,
    baseVaultPda,
    quoteVaultPda,
    poolAuthority,
    eventAuthority,
  };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function getReadOnlyProgram(connection: Connection, network: Network = "devnet"): Program {
  console.log("[vault] getReadOnlyProgram()", { network });
  const cfg = getConfig(network);
  const dummyWallet = {
    publicKey: new PublicKey("11111111111111111111111111111111"),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signTransaction: async (tx: any) => tx,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signAllTransactions: async (txs: any[]) => txs,
  };
  const provider = new AnchorProvider(connection, dummyWallet as AnchorWallet, {
    commitment: "confirmed",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Program(cfg.idl as any, provider);
}

function getProgram(connection: Connection, wallet: AnchorWallet, network: Network = "devnet"): Program {
  console.log("[vault] getProgram()", { wallet: wallet.publicKey.toBase58(), network });
  const cfg = getConfig(network);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Program(cfg.idl as any, provider);
}

function solscanLink(tx: string, network: "devnet" | "mainnet"): string {
  console.log("[vault] solscanLink()", {
    tx: tx.slice(0, 20) + "...",
    network,
  });
  return network === "devnet"
    ? `https://solscan.io/tx/${tx}?cluster=devnet`
    : `https://solscan.io/tx/${tx}`;
}

// ─── Fetch campaign account with fallback for older schema ───────────────────

async function fetchCampaignAccount(
  program: Program,
  connection: Connection,
  campaignPda: PublicKey,
) {
  console.log("[vault] fetchCampaignAccount()", {
    campaignPda: campaignPda.toBase58(),
  });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await (program.account as any).campaign.fetch(campaignPda);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("buffer length") || msg.includes("beyond buffer")) {
      const info = await connection.getAccountInfo(campaignPda);
      if (!info)
        throw new Error(
          `Campaign account not found at ${campaignPda.toBase58()}`,
        );
      return parseCampaignRaw(Buffer.from(info.data));
    }
    throw err;
  }
}

// ─── View: Global State ───────────────────────────────────────────────────────

export async function viewGlobalState(connection: Connection, network: Network = "devnet") {
  console.log("[vault] viewGlobalState()", { network });
  const cfg = getConfig(network);
  const program = getReadOnlyProgram(connection, network);
  const globalStatePda = getGlobalStatePda(network);

  const info = await connection.getAccountInfo(globalStatePda);
  if (!info) throw new Error("Global state account not initialized yet.");
  if (!info.owner.equals(cfg.programId)) {
    throw new Error("Account is not owned by the staking vault program.");
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await (program.account as any).globalState.fetch(
      globalStatePda,
    );
    return {
      globalStatePda: globalStatePda.toBase58(),
      treasuryAdmin: data.treasuryAdmin.toBase58(),
      depositFees: data.depositFees.toString(),
      withdrawFees: data.withdrawFees.toString(),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("buffer length") || msg.includes("beyond buffer")) {
      throw new Error(
        "Account data does not match expected schema (possible IDL/program version mismatch). " +
          "Ensure the IDL matches the deployed program.",
      );
    }
    throw err;
  }
}

// ─── Manual campaign deserializer (handles accounts created before snapshot fields) ──

function parseCampaignRaw(data: Buffer) {
  console.log("[vault] parseCampaignRaw()", { dataLength: data.length });
  let offset = 8; // skip 8-byte Anchor discriminator

  const admin = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;
  const campaignId = new BN(data.slice(offset, offset + 8), "le");
  offset += 8;

  const nameLen = data.readUInt32LE(offset);
  offset += 4;
  const campaignName = data.slice(offset, offset + nameLen).toString("utf8");
  offset += nameLen;

  const depositMint = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;
  const vaultDepositAta = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;
  const endTime = new BN(data.slice(offset, offset + 8), "le");
  offset += 8;
  const totalDeposits = new BN(data.slice(offset, offset + 8), "le");
  offset += 8;
  const bump = data[offset];
  offset += 1;
  const totalUsers = new BN(data.slice(offset, offset + 8), "le");
  offset += 8;
  const activeStatus = data[offset] !== 0;
  offset += 1;
  const withdrawEnabled = data[offset] !== 0;
  offset += 1;
  const claimMint = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;
  const vaultClaimAta = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;
  const claimStatus = data[offset] !== 0;
  offset += 1;

  // These fields were added in a later program version — default to 0 if absent.
  const snapshotTotalDeposits =
    offset + 8 <= data.length
      ? new BN(data.slice(offset, offset + 8), "le")
      : new BN(0);
  offset += 8;
  const snapshotTotalClaim =
    offset + 8 <= data.length
      ? new BN(data.slice(offset, offset + 8), "le")
      : new BN(0);

  return {
    admin,
    campaignId,
    campaignName,
    depositMint,
    vaultDepositAta,
    endTime,
    totalDeposits,
    bump,
    totalUsers,
    activeStatus,
    withdrawEnabled,
    claimMint,
    vaultClaimAta,
    claimStatus,
    snapshotTotalDeposits,
    snapshotTotalClaim,
  };
}

// ─── Check if campaign exists ──────────────────────────────────────────────────

export async function campaignExists(
  connection: Connection,
  campaignId: number,
  network: Network = "devnet",
): Promise<boolean> {
  const cfg = getConfig(network);
  const campaignPda = getCampaignPda(campaignId, network);
  const info = await connection.getAccountInfo(campaignPda);
  return !!(info && info.owner.equals(cfg.programId));
}

// ─── View: Campaign ───────────────────────────────────────────────────────────

export async function viewCampaign(connection: Connection, campaignId: number, network: Network = "devnet") {
  console.log("[vault] viewCampaign()", { campaignId, network });
  const cfg = getConfig(network);
  const program = getReadOnlyProgram(connection, network);
  const campaignPda = getCampaignPda(campaignId, network);

  const info = await connection.getAccountInfo(campaignPda);
  if (!info)
    throw new Error(
      `Campaign ${campaignId} not found. The account does not exist.`,
    );
  if (!info.owner.equals(cfg.programId)) {
    throw new Error("Account is not owned by the staking vault program.");
  }

  const account = await fetchCampaignAccount(program, connection, campaignPda);
  const defaultPubkey = "11111111111111111111111111111111";

  const endTimeBn = BN.isBN(account.endTime)
    ? account.endTime
    : new BN(account.endTime);
  const endTimestamp = parseInt(endTimeBn.toString(), 10);
  const now = Math.floor(Date.now() / 1000);

  let timeStatus: string;
  if (endTimestamp <= now) {
    const elapsed = now - endTimestamp;
    const d = Math.floor(elapsed / 86400);
    const h = Math.floor((elapsed % 86400) / 3600);
    const m = Math.floor((elapsed % 3600) / 60);
    const s = elapsed % 60;
    timeStatus = `ENDED — ended ${d}d ${h}h ${m}m ${s}s ago (${new Date(endTimestamp * 1000).toISOString()})`;
  } else {
    const remaining = endTimestamp - now;
    const d = Math.floor(remaining / 86400);
    const h = Math.floor((remaining % 86400) / 3600);
    const m = Math.floor((remaining % 3600) / 60);
    const s = remaining % 60;
    timeStatus = `ACTIVE — ${d}d ${h}h ${m}m ${s}s remaining (ends ${new Date(endTimestamp * 1000).toISOString()})`;
  }

  return {
    campaignPda: campaignPda.toBase58(),
    admin: account.admin.toBase58(),
    campaignId: account.campaignId.toString(),
    campaignName: account.campaignName ?? "(not set)",
    depositMint: account.depositMint.toBase58(),
    vaultDepositAta: account.vaultDepositAta.toBase58(),
    endTime: endTimeBn.toString(),
    totalDeposits: account.totalDeposits.toString(),
    totalUsers: (account.totalUsers ?? 0).toString(),
    activeStatus: account.activeStatus,
    withdrawEnabled: account.withdrawEnabled,
    claimMint:
      account.claimMint && account.claimMint.toBase58() !== defaultPubkey
        ? account.claimMint.toBase58()
        : "(not set)",
    vaultClaimAta:
      account.vaultClaimAta &&
      account.vaultClaimAta.toBase58() !== defaultPubkey
        ? account.vaultClaimAta.toBase58()
        : "(not set)",
    claimStatus: account.claimStatus ?? false,
    snapshotTotalDeposits: account.snapshotTotalDeposits?.toString(),
    snapshotTotalClaim: account.snapshotTotalClaim?.toString(),
    timeStatus,
  };
}

// ─── View: User Deposit ───────────────────────────────────────────────────────

export async function viewUserState(
  connection: Connection,
  campaignId: number,
  userPubkey: string,
  network: Network = "devnet",
) {
  console.log("[vault] viewUserState()", { campaignId, userPubkey, network });
  const cfg = getConfig(network);
  const program = getReadOnlyProgram(connection, network);
  const user = new PublicKey(userPubkey);
  const campaignPda = getCampaignPda(campaignId, network);
  const userDepositPda = getUserDepositPda(campaignPda, user, network);

  const info = await connection.getAccountInfo(userDepositPda);
  if (!info)
    throw new Error("No deposit record found for this user in this campaign.");
  if (!info.owner.equals(cfg.programId)) {
    throw new Error("Account is not owned by the staking vault program.");
  }

  let data;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data = await (program.account as any).userDeposit.fetch(userDepositPda);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("buffer length") || msg.includes("beyond buffer")) {
      throw new Error(
        "User deposit data does not match expected schema (possible IDL/program version mismatch).",
      );
    }
    throw err;
  }
  // Fetch deposit mint from campaign to resolve decimals
  const campaignAccount = await fetchCampaignAccount(
    program,
    connection,
    campaignPda,
  );
  const depositMint: PublicKey = campaignAccount.depositMint;
  const mintInfo = await getMint(connection, depositMint, "confirmed");
  const decimals = mintInfo.decimals;

  const rawAmount = data.amount.toString();
  const amountUi =
    decimals > 0
      ? (Number(rawAmount) / Math.pow(10, decimals)).toFixed(decimals)
      : rawAmount;

  return {
    campaignPda: campaignPda.toBase58(),
    userDepositPda: userDepositPda.toBase58(),
    userIdPerCampaign: data.userIdPerCampaign.toString(),
    user: data.user.toBase58(),
    depositMint: depositMint.toBase58(),
    rawAmount,
    amountUi,
  };
}

// ─── User: Deposit ────────────────────────────────────────────────────────────

export async function deposit(
  connection: Connection,
  wallet: AnchorWallet,
  params: {
    depositMint: string;
    campaignId: number;
    amount: string;
    network: "devnet" | "mainnet";
  },
): Promise<{ tx: string; link: string }> {
  console.log("[vault] deposit()", {
    ...params,
    caller: wallet.publicKey.toBase58(),
  });
  const program = getProgram(connection, wallet, params.network);
  const depositMint = new PublicKey(params.depositMint);
  const campaignId = new BN(params.campaignId);
  const isNativeSol = depositMint.toBase58() === NATIVE_MINT_ADDRESS;

  const campaignPda = getCampaignPda(campaignId, params.network);
  const globalStatePda = getGlobalStatePda(params.network);

  const campaignAccount = await fetchCampaignAccount(
    program,
    connection,
    campaignPda,
  );
  const vaultDepositAta: PublicKey = campaignAccount.vaultDepositAta;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const globalState = await (program.account as any).globalState.fetch(
    globalStatePda,
  );
  const treasuryAdmin: PublicKey = globalState.treasuryAdmin;

  const treasuryDepositAta = getAssociatedTokenAddressSync(
    depositMint,
    treasuryAdmin,
    false,
    TOKEN_PROGRAM_ID,
  );

  let amount: BN;
  let userDepositAta: PublicKey;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const preInstructions: any[] = [];

  if (isNativeSol) {
    const solAmount = parseFloat(params.amount);
    amount = new BN(Math.round(solAmount * LAMPORTS_PER_SOL));
    userDepositAta = getAssociatedTokenAddressSync(
      NATIVE_MINT,
      wallet.publicKey,
      false,
      TOKEN_PROGRAM_ID,
    );

    // Idempotent ATA creation + wrap SOL
    preInstructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey,
        userDepositAta,
        wallet.publicKey,
        NATIVE_MINT,
      ),
    );
    preInstructions.push(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: userDepositAta,
        lamports: amount.toNumber(),
      }),
    );
    preInstructions.push(
      createSyncNativeInstruction(userDepositAta, TOKEN_PROGRAM_ID),
    );
  } else {
    amount = new BN(params.amount);
    userDepositAta = getAssociatedTokenAddressSync(
      depositMint,
      wallet.publicKey,
      false,
      TOKEN_PROGRAM_ID,
    );
  }

  // Ensure treasury ATA exists
  const treasuryInfo = await connection.getAccountInfo(treasuryDepositAta);
  if (!treasuryInfo) {
    preInstructions.push(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey,
        treasuryDepositAta,
        treasuryAdmin,
        depositMint,
      ),
    );
  }

  const userDepositPda = getUserDepositPda(campaignPda, wallet.publicKey, params.network);

  const tx = await program.methods
    .deposit(amount)
    .accounts({
      user: wallet.publicKey,
      globalState: globalStatePda,
      campaign: campaignPda,
      userDeposit: userDepositPda,
      depositMint,
      userDepositAta,
      vaultDepositAta,
      treasuryDepositAta,
      treasuryAdmin,
      depositTokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions(preInstructions)
    .rpc();

  console.log("[vault] deposit() tx:", tx);
  return { tx, link: solscanLink(tx, params.network) };
}

// ─── User: Withdraw ───────────────────────────────────────────────────────────

export async function withdraw(
  connection: Connection,
  wallet: AnchorWallet,
  params: {
    depositMint: string;
    campaignId: number;
    amount: string;
    unwrap: boolean;
    network: "devnet" | "mainnet";
  },
): Promise<{ tx: string; link: string; unwrapTx?: string }> {
  console.log("[vault] withdraw()", {
    ...params,
    caller: wallet.publicKey.toBase58(),
  });
  const program = getProgram(connection, wallet, params.network);
  const depositMint = new PublicKey(params.depositMint);
  const campaignId = new BN(params.campaignId);
  const isNativeSol = depositMint.toBase58() === NATIVE_MINT_ADDRESS;

  const campaignPda = getCampaignPda(campaignId, params.network);
  const globalStatePda = getGlobalStatePda(params.network);

  const campaignAccount = await fetchCampaignAccount(
    program,
    connection,
    campaignPda,
  );
  const vaultDepositAta: PublicKey = campaignAccount.vaultDepositAta;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const globalState = await (program.account as any).globalState.fetch(
    globalStatePda,
  );
  const treasuryAdmin: PublicKey = globalState.treasuryAdmin;

  const treasuryDepositAta = getAssociatedTokenAddressSync(
    depositMint,
    treasuryAdmin,
    false,
    TOKEN_PROGRAM_ID,
  );

  let amount: BN;
  let userDepositAta: PublicKey;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const preInstructions: any[] = [];

  if (isNativeSol) {
    const solAmount = parseFloat(params.amount);
    amount = new BN(Math.round(solAmount * LAMPORTS_PER_SOL));
    userDepositAta = getAssociatedTokenAddressSync(
      NATIVE_MINT,
      wallet.publicKey,
      false,
      TOKEN_PROGRAM_ID,
    );
    preInstructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey,
        userDepositAta,
        wallet.publicKey,
        NATIVE_MINT,
      ),
    );
  } else {
    amount = new BN(params.amount);
    userDepositAta = getAssociatedTokenAddressSync(
      depositMint,
      wallet.publicKey,
      false,
      TOKEN_PROGRAM_ID,
    );
    preInstructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey,
        userDepositAta,
        wallet.publicKey,
        depositMint,
      ),
    );
  }

  // Ensure treasury ATA exists
  const treasuryInfo = await connection.getAccountInfo(treasuryDepositAta);
  if (!treasuryInfo) {
    preInstructions.push(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey,
        treasuryDepositAta,
        treasuryAdmin,
        depositMint,
      ),
    );
  }

  const userDepositPda = getUserDepositPda(campaignPda, wallet.publicKey, params.network);

  const tx = await program.methods
    .withdraw(amount)
    .accounts({
      user: wallet.publicKey,
      globalState: globalStatePda,
      campaign: campaignPda,
      userDeposit: userDepositPda,
      depositMint,
      userDepositAta,
      vaultDepositAta,
      treasuryDepositAta,
      treasuryAdmin,
      depositTokenProgram: TOKEN_PROGRAM_ID,
    })
    .preInstructions(preInstructions)
    .rpc();

  // Unwrap wSOL → native SOL if requested
  if (isNativeSol && params.unwrap) {
    const provider = new AnchorProvider(connection, wallet, {
      commitment: "confirmed",
    });
    const { Transaction } = await import("@solana/web3.js");
    const unwrapTxSig = await provider.sendAndConfirm(
      new Transaction().add(
        createCloseAccountInstruction(
          userDepositAta,
          wallet.publicKey,
          wallet.publicKey,
          [],
          TOKEN_PROGRAM_ID,
        ),
      ),
    );
    console.log("[vault] withdraw() tx:", tx, "unwrapTx:", unwrapTxSig);
    return { tx, link: solscanLink(tx, params.network), unwrapTx: unwrapTxSig };
  }

  console.log("[vault] withdraw() tx:", tx);
  return { tx, link: solscanLink(tx, params.network) };
}

// ─── User: Claim ──────────────────────────────────────────────────────────────

export async function userClaim(
  connection: Connection,
  wallet: AnchorWallet,
  params: {
    campaignId: number;
    useToken2022: boolean;
    network: "devnet" | "mainnet";
  },
): Promise<{ tx: string; link: string }> {
  console.log("[vault] userClaim()", {
    ...params,
    caller: wallet.publicKey.toBase58(),
  });
  const program = getProgram(connection, wallet, params.network);
  const campaignId = new BN(params.campaignId);
  const claimTokenProgram = params.useToken2022
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;

  const campaignPda = getCampaignPda(campaignId, params.network);
  const campaignAccount = await fetchCampaignAccount(
    program,
    connection,
    campaignPda,
  );
  const claimMint: PublicKey = campaignAccount.claimMint;
  const vaultClaimAta: PublicKey = campaignAccount.vaultClaimAta;

  const defaultPubkey = "11111111111111111111111111111111";
  if (claimMint.toBase58() === defaultPubkey) {
    throw new Error(
      "Claim mint not set on campaign. Run swap or load_claim_tokens first.",
    );
  }

  const userDepositPda = getUserDepositPda(campaignPda, wallet.publicKey, params.network);
  const userClaimAta = getAssociatedTokenAddressSync(
    claimMint,
    wallet.publicKey,
    false,
    claimTokenProgram,
  );

  const preInstructions = [];
  const userClaimAtaInfo = await connection.getAccountInfo(userClaimAta);
  if (!userClaimAtaInfo) {
    preInstructions.push(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey,
        userClaimAta,
        wallet.publicKey,
        claimMint,
        claimTokenProgram,
      ),
    );
  }

  const tx = await program.methods
    .userClaim()
    .accounts({
      payer: wallet.publicKey,
      campaign: campaignPda,
      userDeposit: userDepositPda,
      user: wallet.publicKey,
      claimMint,
      userClaimAta,
      vaultClaimAta,
      claimTokenProgram,
    })
    .preInstructions(preInstructions)
    .rpc();

  console.log("[vault] userClaim() tx:", tx);
  return { tx, link: solscanLink(tx, params.network) };
}

// ─── User: Withdraw All ───────────────────────────────────────────────────────

export async function withdrawAll(
  connection: Connection,
  wallet: AnchorWallet,
  params: {
    depositMint: string;
    campaignId: number;
    unwrap: boolean;
    network: "devnet" | "mainnet";
  },
): Promise<{ tx: string; link: string; unwrapTx?: string }> {
  console.log("[vault] withdrawAll()", {
    ...params,
    caller: wallet.publicKey.toBase58(),
  });
  const program = getReadOnlyProgram(connection, params.network);
  const campaignPda = getCampaignPda(params.campaignId, params.network);
  const userDepositPda = getUserDepositPda(campaignPda, wallet.publicKey, params.network);

  const info = await connection.getAccountInfo(userDepositPda);
  if (!info)
    throw new Error("No deposit record found for this user in this campaign.");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userDeposit = await (program.account as any).userDeposit.fetch(
    userDepositPda,
  );
  const amount: BN = userDeposit.amount;
  if (amount.isZero()) throw new Error("Your deposited balance is already 0.");

  const depositMint = new PublicKey(params.depositMint);
  const isNativeSol = depositMint.toBase58() === NATIVE_MINT_ADDRESS;

  // Convert lamports → SOL string for native SOL, otherwise use raw BN string
  const amountParam = isNativeSol
    ? (amount.toNumber() / LAMPORTS_PER_SOL).toString()
    : amount.toString();

  return withdraw(connection, wallet, {
    depositMint: params.depositMint,
    campaignId: params.campaignId,
    amount: amountParam,
    unwrap: params.unwrap,
    network: params.network,
  });
}

// ─── Admin: Initialize Global State ──────────────────────────────────────────

export async function initializeGlobalState(
  connection: Connection,
  wallet: AnchorWallet,
  params: { network: "devnet" | "mainnet" },
): Promise<{ tx: string; link: string }> {
  console.log("[vault] initializeGlobalState()", {
    ...params,
    caller: wallet.publicKey.toBase58(),
  });
  const program = getProgram(connection, wallet, params.network);
  const globalStatePda = getGlobalStatePda(params.network);

  const existing = await connection.getAccountInfo(globalStatePda);
  if (existing) throw new Error("Global state already initialized.");

  const tx = await program.methods
    .initializeGlobalState(new BN(10), new BN(5))
    .accounts({
      deployer: wallet.publicKey,
      treasuryAdmin: wallet.publicKey,
      globalState: globalStatePda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("[vault] initializeGlobalState() tx:", tx);
  return { tx, link: solscanLink(tx, params.network) };
}

// ─── Admin: Initialize Campaign ───────────────────────────────────────────────

export async function initializeCampaign(
  connection: Connection,
  wallet: AnchorWallet,
  params: {
    depositMint: string;
    campaignId: number;
    campaignName: string;
    durationSeconds: number;
    network: "devnet" | "mainnet";
  },
): Promise<{ tx: string; link: string }> {
  console.log("[vault] initializeCampaign()", {
    ...params,
    caller: wallet.publicKey.toBase58(),
  });
  const program = getProgram(connection, wallet, params.network);
  const depositMint = new PublicKey(params.depositMint);
  const campaignId = new BN(params.campaignId);
  const duration = new BN(params.durationSeconds);

  const campaignPda = getCampaignPda(campaignId, params.network);
  const globalStatePda = getGlobalStatePda(params.network);
  const vaultDepositAta = getAssociatedTokenAddressSync(
    depositMint,
    campaignPda,
    true,
    TOKEN_PROGRAM_ID,
  );

  const tx = await program.methods
    .initializeCampaign(campaignId, params.campaignName, duration)
    .accounts({
      admin: wallet.publicKey,
      globalState: globalStatePda,
      campaign: campaignPda,
      depositMint,
      vaultDepositAta,
      depositTokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("[vault] initializeCampaign() tx:", tx);
  return { tx, link: solscanLink(tx, params.network) };
}

// ─── Admin: Update Fees ───────────────────────────────────────────────────────

export async function updateFees(
  connection: Connection,
  wallet: AnchorWallet,
  params: {
    depositFeeBps: number;
    withdrawFeeBps: number;
    network: "devnet" | "mainnet";
  },
): Promise<{ tx: string; link: string }> {
  console.log("[vault] updateFees()", {
    ...params,
    caller: wallet.publicKey.toBase58(),
  });
  const program = getProgram(connection, wallet, params.network);
  const globalStatePda = getGlobalStatePda(params.network);

  const tx = await program.methods
    .updateFees(new BN(params.depositFeeBps), new BN(params.withdrawFeeBps))
    .accounts({ deployer: wallet.publicKey, globalState: globalStatePda })
    .rpc();

  console.log("[vault] updateFees() tx:", tx);
  return { tx, link: solscanLink(tx, params.network) };
}

// ─── Admin: Set Treasury Admin ────────────────────────────────────────────────

export async function setTreasuryAdmin(
  connection: Connection,
  wallet: AnchorWallet,
  params: { newTreasuryAdmin: string; network: "devnet" | "mainnet" },
): Promise<{ tx: string; link: string }> {
  console.log("[vault] setTreasuryAdmin()", {
    ...params,
    caller: wallet.publicKey.toBase58(),
  });
  const program = getProgram(connection, wallet, params.network);
  const globalStatePda = getGlobalStatePda(params.network);
  const newAdmin = new PublicKey(params.newTreasuryAdmin);

  const tx = await program.methods
    .setTreasuryAdmin(newAdmin)
    .accounts({ deployer: wallet.publicKey, globalState: globalStatePda })
    .rpc();

  console.log("[vault] setTreasuryAdmin() tx:", tx);
  return { tx, link: solscanLink(tx, params.network) };
}

// ─── Admin: Set Active Status ─────────────────────────────────────────────────

export async function setActiveStatus(
  connection: Connection,
  wallet: AnchorWallet,
  params: {
    campaignId: number;
    status: boolean;
    network: "devnet" | "mainnet";
  },
): Promise<{ tx: string; link: string }> {
  console.log("[vault] setActiveStatus()", {
    ...params,
    caller: wallet.publicKey.toBase58(),
  });
  const program = getProgram(connection, wallet, params.network);
  const campaignPda = getCampaignPda(params.campaignId, params.network);

  const tx = await program.methods
    .setActiveStatus(params.status)
    .accounts({ admin: wallet.publicKey, campaign: campaignPda })
    .rpc();

  console.log("[vault] setActiveStatus() tx:", tx);
  return { tx, link: solscanLink(tx, params.network) };
}

// ─── Admin: Set Withdraw Enabled ──────────────────────────────────────────────

export async function setWithdrawEnabled(
  connection: Connection,
  wallet: AnchorWallet,
  params: {
    campaignId: number;
    enabled: boolean;
    network: "devnet" | "mainnet";
  },
): Promise<{ tx: string; link: string }> {
  console.log("[vault] setWithdrawEnabled()", {
    ...params,
    caller: wallet.publicKey.toBase58(),
  });
  const program = getProgram(connection, wallet, params.network);
  const campaignPda = getCampaignPda(params.campaignId, params.network);

  const tx = await program.methods
    .setWithdrawEnabled(params.enabled)
    .accounts({ admin: wallet.publicKey, campaign: campaignPda })
    .rpc();

  console.log("[vault] setWithdrawEnabled() tx:", tx);
  return { tx, link: solscanLink(tx, params.network) };
}

// ─── Admin: Set Claim Status ──────────────────────────────────────────────────

export async function setClaimStatus(
  connection: Connection,
  wallet: AnchorWallet,
  params: {
    campaignId: number;
    status: boolean;
    network: "devnet" | "mainnet";
  },
): Promise<{ tx: string; link: string }> {
  console.log("[vault] setClaimStatus()", {
    ...params,
    caller: wallet.publicKey.toBase58(),
  });
  const program = getProgram(connection, wallet, params.network);
  const campaignPda = getCampaignPda(params.campaignId, params.network);

  const tx = await program.methods
    .setClaimStatus(params.status)
    .accounts({ admin: wallet.publicKey, campaign: campaignPda })
    .rpc();

  console.log("[vault] setClaimStatus() tx:", tx);
  return { tx, link: solscanLink(tx, params.network) };
}

// ─── Admin: Load Claim Tokens ─────────────────────────────────────────────────

export async function loadClaimTokens(
  connection: Connection,
  wallet: AnchorWallet,
  params: {
    campaignId: number;
    claimMint: string;
    amount: string;
    network: "devnet" | "mainnet";
  },
): Promise<{ tx: string; link: string }> {
  console.log("[vault] loadClaimTokens()", {
    ...params,
    caller: wallet.publicKey.toBase58(),
  });
  const program = getProgram(connection, wallet, params.network);
  const campaignId = new BN(params.campaignId);
  const claimMint = new PublicKey(params.claimMint);
  const amount = new BN(params.amount);

  const campaignPda = getCampaignPda(campaignId, params.network);
  const vaultClaimAta = getAssociatedTokenAddressSync(
    claimMint,
    campaignPda,
    true,
    TOKEN_PROGRAM_ID,
  );
  const adminClaimAta = getAssociatedTokenAddressSync(
    claimMint,
    wallet.publicKey,
    false,
    TOKEN_PROGRAM_ID,
  );

  // Ensure admin ATA exists
  const preInstructions = [];
  const adminAtaInfo = await connection.getAccountInfo(adminClaimAta);
  if (!adminAtaInfo) {
    preInstructions.push(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey,
        adminClaimAta,
        wallet.publicKey,
        claimMint,
      ),
    );
  }

  const tx = await program.methods
    .loadClaimTokens(amount)
    .accounts({
      admin: wallet.publicKey,
      campaign: campaignPda,
      claimMint,
      adminClaimAta,
      vaultClaimAta,
      claimTokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions(preInstructions)
    .rpc();

  console.log("[vault] loadClaimTokens() tx:", tx);
  return { tx, link: solscanLink(tx, params.network) };
}

// ─── Admin: Swap ──────────────────────────────────────────────────────────────

export async function swap(
  connection: Connection,
  wallet: AnchorWallet,
  params: {
    campaignId: number;
    minimumAmountOut: string;
    configPubkey: string;
    outputMint: string;
    useToken2022: boolean;
    network: "devnet" | "mainnet";
  },
): Promise<{ tx: string; link: string }> {
  console.log("[vault] swap()", {
    ...params,
    caller: wallet.publicKey.toBase58(),
  });
  const program = getProgram(connection, wallet, params.network);
  const campaignId = new BN(params.campaignId);
  const minimumAmountOut = new BN(params.minimumAmountOut);
  const configPubkey = new PublicKey(params.configPubkey);
  const outputMint = new PublicKey(params.outputMint);

  const campaignPda = getCampaignPda(campaignId, params.network);
  const campaignAccount = await fetchCampaignAccount(
    program,
    connection,
    campaignPda,
  );
  const quoteMint: PublicKey = campaignAccount.depositMint;
  const vaultDepositAta: PublicKey = campaignAccount.vaultDepositAta;

  const tokenBaseProgram = params.useToken2022
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;
  const tokenQuoteProgram = TOKEN_PROGRAM_ID;
  const tokenProgram = params.useToken2022
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;

  const {
    poolPda,
    baseVaultPda,
    quoteVaultPda,
    poolAuthority,
    eventAuthority,
  } = derivePoolPdas(configPubkey, outputMint, quoteMint);

  const outputTokenAccount = getAssociatedTokenAddressSync(
    outputMint,
    campaignPda,
    true,
    tokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  const tx = await program.methods
    .swap(minimumAmountOut)
    .accounts({
      admin: wallet.publicKey,
      campaign: campaignPda,
      poolAuthority,
      config: configPubkey,
      pool: poolPda,
      inputTokenAccount: vaultDepositAta,
      outputTokenAccount,
      outputMint,
      baseVault: baseVaultPda,
      quoteVault: quoteVaultPda,
      baseMint: outputMint,
      quoteMint,
      tokenBaseProgram,
      tokenQuoteProgram,
      tokenProgram,
      referralTokenAccount: null,
      eventAuthority,
      dbcProgram: DBC_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as any)
    .rpc();

  console.log("[vault] swap() tx:", tx);
  return { tx, link: solscanLink(tx, params.network) };
}

// ─── Admin: Admin Withdraw ────────────────────────────────────────────────────

export async function adminWithdraw(
  connection: Connection,
  wallet: AnchorWallet,
  params: { campaignId: number; amount: string; network: "devnet" | "mainnet" },
): Promise<{ tx: string; link: string }> {
  console.log("[vault] adminWithdraw()", {
    ...params,
    caller: wallet.publicKey.toBase58(),
  });
  const program = getProgram(connection, wallet, params.network);
  const campaignId = new BN(params.campaignId);

  const campaignPda = getCampaignPda(campaignId, params.network);
  const globalStatePda = getGlobalStatePda(params.network);

  const campaignAccount = await fetchCampaignAccount(
    program,
    connection,
    campaignPda,
  );
  const depositMint: PublicKey = campaignAccount.depositMint;
  const vaultDepositAta: PublicKey = campaignAccount.vaultDepositAta;
  const isNativeSol = depositMint.toBase58() === NATIVE_MINT_ADDRESS;

  let amount: BN;
  if (isNativeSol) {
    amount = new BN(Math.round(parseFloat(params.amount) * LAMPORTS_PER_SOL));
  } else {
    amount = new BN(params.amount);
  }

  const treasuryDepositAta = getAssociatedTokenAddressSync(
    depositMint,
    wallet.publicKey,
    false,
    TOKEN_PROGRAM_ID,
  );
  const preInstructions = [];
  const ataInfo = await connection.getAccountInfo(treasuryDepositAta);
  if (!ataInfo) {
    preInstructions.push(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey,
        treasuryDepositAta,
        wallet.publicKey,
        depositMint,
      ),
    );
  }

  const tx = await program.methods
    .adminWithdraw(amount)
    .accounts({
      treasuryAdmin: wallet.publicKey,
      globalState: globalStatePda,
      campaign: campaignPda,
      depositMint,
      treasuryDepositAta,
      vaultDepositAta,
      depositTokenProgram: TOKEN_PROGRAM_ID,
    })
    .preInstructions(preInstructions)
    .rpc();

  console.log("[vault] adminWithdraw() tx:", tx);
  return { tx, link: solscanLink(tx, params.network) };
}

// ─── Admin: Change Campaign Admin ─────────────────────────────────────────────

export async function changeCampaignAdmin(
  connection: Connection,
  wallet: AnchorWallet,
  params: {
    campaignId: number;
    newAdmin: string;
    network: "devnet" | "mainnet";
  },
): Promise<{ tx: string; link: string }> {
  console.log("[vault] changeCampaignAdmin()", {
    ...params,
    caller: wallet.publicKey.toBase58(),
  });
  const program = getProgram(connection, wallet, params.network);
  const campaignPda = getCampaignPda(params.campaignId, params.network);
  const newAdmin = new PublicKey(params.newAdmin);

  const tx = await program.methods
    .changeCampaignAdmin(newAdmin)
    .accounts({ deployer: wallet.publicKey, campaign: campaignPda })
    .rpc();

  console.log("[vault] changeCampaignAdmin() tx:", tx);
  return { tx, link: solscanLink(tx, params.network) };
}

// ─── Admin: Update Campaign Duration ─────────────────────────────────────────

export async function updateCampaignDuration(
  connection: Connection,
  wallet: AnchorWallet,
  params: {
    campaignId: number;
    newDurationSeconds: number;
    network: "devnet" | "mainnet";
  },
): Promise<{ tx: string; link: string }> {
  console.log("[vault] updateCampaignDuration()", {
    ...params,
    caller: wallet.publicKey.toBase58(),
  });
  const program = getProgram(connection, wallet, params.network);
  const campaignPda = getCampaignPda(params.campaignId, params.network);

  const tx = await program.methods
    .updateCampaignDuration(new BN(params.newDurationSeconds))
    .accounts({ admin: wallet.publicKey, campaign: campaignPda })
    .rpc();

  console.log("[vault] updateCampaignDuration() tx:", tx);
  return { tx, link: solscanLink(tx, params.network) };
}

// ─── Helper: fetch quote mint + on-chain decimals from campaign ──────────────

async function fetchCampaignQuoteMintInfo(
  connection: Connection,
  program: Program,
  campaignPda: PublicKey,
): Promise<{
  quoteMint: PublicKey;
  quoteDecimals: number;
  vaultDepositAta: PublicKey;
}> {
  console.log("[vault] fetchCampaignQuoteMintInfo()", {
    campaignPda: campaignPda.toBase58(),
  });
  const account = await fetchCampaignAccount(program, connection, campaignPda);
  const quoteMint: PublicKey = account.depositMint;
  const vaultDepositAta: PublicKey = account.vaultDepositAta;
  // getMint reads the on-chain mint account to get the actual decimal precision
  const mintInfo = await getMint(connection, quoteMint, "confirmed");
  return { quoteMint, quoteDecimals: mintInfo.decimals, vaultDepositAta };
}

// ─── Admin: Create Config (DBC) ──────────────────────────────────────────────
// Creates the DBC config account. Returns config pubkey for use in createPool.

export async function createConfig(
  connection: Connection,
  wallet: AnchorWallet,
  params: {
    quoteMint: string;
    migrationQuoteThreshold: number;
    network: "devnet" | "mainnet";
  },
): Promise<{ tx: string; link: string; configPubkey: string }> {
  console.log("[vault] createConfig()", {
    ...params,
    caller: wallet.publicKey.toBase58(),
  });

  const quoteMint = new PublicKey(params.quoteMint);
  const mintInfo = await getMint(connection, quoteMint, "confirmed");
  const quoteDecimals = mintInfo.decimals;

  const config = Keypair.generate();
  console.log("[vault] createConfig() config:", config.publicKey.toBase58());

  const preMigrationEndingFeeBps = 500;
  const postMigrationEndingFeeBps = 1;
  const dammV2BaseFeeMode = DammV2BaseFeeMode.FeeTimeSchedulerLinear;

  const migratedPoolMarketCapFeeSchedulerParams =
    getMigratedPoolMarketCapFeeSchedulerParams(
      preMigrationEndingFeeBps,
      postMigrationEndingFeeBps,
      dammV2BaseFeeMode,
      10,
      500,
      86400 * 30,
    );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const curveConfig = buildCurve({
    token: {
      tokenType: 1,
      tokenBaseDecimal: 9,
      tokenQuoteDecimal: quoteDecimals,
      tokenUpdateAuthority: 1,
      totalTokenSupply: 1_000_000_000,
      leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerExponential,
        feeSchedulerParam: {
          startingFeeBps: 100,
          endingFeeBps: 100,
          numberOfPeriod: 0,
          totalDuration: 0,
        },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: 0,
      creatorTradingFeePercentage: 50,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: true,
    },
    migration: {
      migrationOption: 1,
      migrationFeeOption: 6,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
      migratedPoolFee: {
        collectFeeMode: 0,
        dynamicFee: 0,
        poolFeeBps: 400,
        baseFeeMode: dammV2BaseFeeMode,
        marketCapFeeSchedulerParams: {
          numberOfPeriod:
            migratedPoolMarketCapFeeSchedulerParams.numberOfPeriod,
          sqrtPriceStepBps:
            migratedPoolMarketCapFeeSchedulerParams.sqrtPriceStepBps,
          schedulerExpirationDuration:
            migratedPoolMarketCapFeeSchedulerParams.schedulerExpirationDuration,
          endingBaseFeeBps: postMigrationEndingFeeBps,
        },
      },
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: 40,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 60,
      creatorLiquidityPercentage: 0,
      partnerLiquidityVestingInfoParams: {
        vestingPercentage: 0,
        bpsPerPeriod: 0,
        numberOfPeriods: 0,
        cliffDurationFromMigrationTime: 0,
        totalDuration: 0,
      },
      creatorLiquidityVestingInfoParams: {
        vestingPercentage: 0,
        bpsPerPeriod: 0,
        numberOfPeriods: 0,
        cliffDurationFromMigrationTime: 0,
        totalDuration: 0,
      },
    },
    lockedVesting: {
      totalLockedVestingAmount: 0,
      numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0,
      totalVestingDuration: 0,
      cliffDurationFromMigrationTime: 0,
    },
    activationType: 1,
    percentageSupplyOnMigration: 20,
    migrationQuoteThreshold: params.migrationQuoteThreshold,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  const client = new DynamicBondingCurveClient(connection, "confirmed");
  const configTx: Transaction = await client.partner.createConfig({
    config: config.publicKey,
    feeClaimer: wallet.publicKey,
    leftoverReceiver: wallet.publicKey,
    payer: wallet.publicKey,
    quoteMint,
    ...curveConfig,
  });

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  tx.add(...configTx.instructions);

  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  const txSig = await provider.sendAndConfirm(tx, [config]);

  console.log("[vault] createConfig() tx:", txSig);
  return {
    tx: txSig,
    link: solscanLink(txSig, params.network),
    configPubkey: config.publicKey.toBase58(),
  };
}

// ─── Admin: Create Pool (DBC) ─────────────────────────────────────────────────
// Creates the DBC pool. Requires an existing config from createConfig.

export async function createPool(
  connection: Connection,
  wallet: AnchorWallet,
  params: {
    configPubkey: string;
    poolName: string;
    poolSymbol: string;
    poolUri: string;
    network: "devnet" | "mainnet";
  },
): Promise<{
  tx: string;
  link: string;
  configPubkey: string;
  baseMintPubkey: string;
  poolAddress: string;
}> {
  console.log("[vault] createPool()", {
    ...params,
    caller: wallet.publicKey.toBase58(),
  });

  const config = new PublicKey(params.configPubkey);
  const baseMint = Keypair.generate();
  console.log("[vault] createPool() baseMint:", baseMint.publicKey.toBase58());

  const client = new DynamicBondingCurveClient(connection, "confirmed");
  const poolTx: Transaction = await client.pool.createPool({
    config,
    baseMint: baseMint.publicKey,
    name: params.poolName,
    symbol: params.poolSymbol,
    uri: params.poolUri,
    payer: wallet.publicKey,
    poolCreator: wallet.publicKey,
  });

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  tx.add(...poolTx.instructions);

  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  const txSig = await provider.sendAndConfirm(tx, [baseMint]);

  // Fetch the derived pool address from chain after confirmation
  const pools = await client.state.getPoolsByConfig(config);
  const poolAddress = pools.length > 0 ? pools[0].publicKey.toBase58() : "";

  console.log("[vault] createPool() tx:", txSig, "pool:", poolAddress);
  return {
    tx: txSig,
    link: solscanLink(txSig, params.network),
    configPubkey: params.configPubkey,
    baseMintPubkey: baseMint.publicKey.toBase58(),
    poolAddress,
  };
}

// ─── Admin: Create Config + Pool + Swap (atomic) ──────────────────────────────
// Combines createConfig + createPool + swap into a single atomic transaction.

export async function createConfigPoolAndSwap(
  connection: Connection,
  wallet: AnchorWallet,
  params: {
    campaignId: number;
    migrationQuoteThreshold: number;
    minimumAmountOut: string;
    poolName: string;
    poolSymbol: string;
    poolUri: string;
    network: "devnet" | "mainnet";
  },
): Promise<{ tx: string; link: string; configPubkey: string; baseMintPubkey: string; poolQuoteProgress: number | null }> {
  console.log("[vault] createConfigPoolAndSwap()", {
    ...params,
    caller: wallet.publicKey.toBase58(),
  });

  console.log("[vault] createConfigPoolAndSwap() step 1: get program and campaign PDA");
  const program = getProgram(connection, wallet, params.network);
  const campaignId = new BN(params.campaignId);
  const campaignPda = getCampaignPda(campaignId, params.network);
  console.log("[vault] createConfigPoolAndSwap() campaignPda:", campaignPda.toBase58());

  console.log("[vault] createConfigPoolAndSwap() step 2: fetch campaign quote mint info");
  const { quoteMint, quoteDecimals, vaultDepositAta } =
    await fetchCampaignQuoteMintInfo(connection, program, campaignPda);
  console.log("[vault] createConfigPoolAndSwap() quoteMint:", quoteMint.toBase58(), "quoteDecimals:", quoteDecimals, "vaultDepositAta:", vaultDepositAta.toBase58());

  console.log("[vault] createConfigPoolAndSwap() step 3: generate config and baseMint keypairs");
  const config = Keypair.generate();
  const baseMint = Keypair.generate();
  console.log("[vault] createConfigPoolAndSwap() config:", config.publicKey.toBase58());
  console.log("[vault] createConfigPoolAndSwap() baseMint:", baseMint.publicKey.toBase58());

  console.log("[vault] createConfigPoolAndSwap() step 4: build migrated pool params");
  const preMigrationEndingFeeBps = 500;
  const postMigrationEndingFeeBps = 1;
  const dammV2BaseFeeMode = DammV2BaseFeeMode.FeeTimeSchedulerLinear;

  const migratedPoolMarketCapFeeSchedulerParams =
    getMigratedPoolMarketCapFeeSchedulerParams(
      preMigrationEndingFeeBps,
      postMigrationEndingFeeBps,
      dammV2BaseFeeMode,
      10,
      500,
      86400 * 30,
    );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const curveConfig = buildCurve({
    token: {
      tokenType: 1,
      tokenBaseDecimal: 9,
      tokenQuoteDecimal: quoteDecimals,
      tokenUpdateAuthority: 1,
      totalTokenSupply: 1_000_000_000,
      leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerExponential,
        feeSchedulerParam: {
          startingFeeBps: 100,
          endingFeeBps: 100,
          numberOfPeriod: 0,
          totalDuration: 0,
        },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: 0,
      creatorTradingFeePercentage: 50,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: true,
    },
    migration: {
      migrationOption: 1,
      migrationFeeOption: 6,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
      migratedPoolFee: {
        collectFeeMode: 0,
        dynamicFee: 0,
        poolFeeBps: 400,
        baseFeeMode: dammV2BaseFeeMode,
        marketCapFeeSchedulerParams: {
          numberOfPeriod: migratedPoolMarketCapFeeSchedulerParams.numberOfPeriod,
          sqrtPriceStepBps: migratedPoolMarketCapFeeSchedulerParams.sqrtPriceStepBps,
          schedulerExpirationDuration:
            migratedPoolMarketCapFeeSchedulerParams.schedulerExpirationDuration,
          endingBaseFeeBps: postMigrationEndingFeeBps,
        },
      },
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: 40,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 60,
      creatorLiquidityPercentage: 0,
      partnerLiquidityVestingInfoParams: {
        vestingPercentage: 0,
        bpsPerPeriod: 0,
        numberOfPeriods: 0,
        cliffDurationFromMigrationTime: 0,
        totalDuration: 0,
      },
      creatorLiquidityVestingInfoParams: {
        vestingPercentage: 0,
        bpsPerPeriod: 0,
        numberOfPeriods: 0,
        cliffDurationFromMigrationTime: 0,
        totalDuration: 0,
      },
    },
    lockedVesting: {
      totalLockedVestingAmount: 0,
      numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0,
      totalVestingDuration: 0,
      cliffDurationFromMigrationTime: 0,
    },
    activationType: 1,
    percentageSupplyOnMigration: 20,
    migrationQuoteThreshold: params.migrationQuoteThreshold,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  console.log("[vault] createConfigPoolAndSwap() step 5: curveConfig built");

  console.log("[vault] createConfigPoolAndSwap() step 6: create DynamicBondingCurveClient");
  const client = new DynamicBondingCurveClient(connection, "confirmed");

  console.log("[vault] createConfigPoolAndSwap() step 7: build configAndPoolTx via SDK");
  const configAndPoolTx = await client.pool.createConfigAndPool({
    config: config.publicKey,
    feeClaimer: wallet.publicKey,
    leftoverReceiver: wallet.publicKey,
    payer: wallet.publicKey,
    quoteMint,
    ...curveConfig,
    preCreatePoolParam: {
      name: params.poolName,
      symbol: params.poolSymbol,
      uri: params.poolUri,
      poolCreator: wallet.publicKey,
      baseMint: baseMint.publicKey,
    },
  });
  console.log("[vault] createConfigPoolAndSwap() step 8: configAndPoolTx built, instructions:", configAndPoolTx.instructions.length);

  console.log("[vault] createConfigPoolAndSwap() step 9: derive pool PDAs");
  const { poolPda, baseVaultPda, quoteVaultPda, poolAuthority, eventAuthority } =
    derivePoolPdas(config.publicKey, baseMint.publicKey, quoteMint);
  console.log("[vault] createConfigPoolAndSwap() poolPda:", poolPda.toBase58(), "baseVaultPda:", baseVaultPda.toBase58(), "quoteVaultPda:", quoteVaultPda.toBase58());

  console.log("[vault] createConfigPoolAndSwap() step 10: get output token account ATA");
  const outputTokenAccount = getAssociatedTokenAddressSync(
    baseMint.publicKey,
    campaignPda,
    true,
    TOKEN_2022_PROGRAM_ID,
  );
  console.log("[vault] createConfigPoolAndSwap() outputTokenAccount:", outputTokenAccount.toBase58());

  console.log("[vault] createConfigPoolAndSwap() step 11: build swap instruction");
  const swapIx = await program.methods
    .swap(new BN(params.campaignId))
    .accounts({
      admin: wallet.publicKey,
      campaign: campaignPda,
      poolAuthority,
      config: config.publicKey,
      pool: poolPda,
      inputTokenAccount: vaultDepositAta,
      outputTokenAccount,
      outputMint: baseMint.publicKey,
      baseVault: baseVaultPda,
      quoteVault: quoteVaultPda,
      baseMint: baseMint.publicKey,
      quoteMint,
      tokenBaseProgram: TOKEN_2022_PROGRAM_ID,
      tokenQuoteProgram: TOKEN_PROGRAM_ID,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      referralTokenAccount: null,
      eventAuthority,
      dbcProgram: DBC_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as any)
    .instruction();
  console.log("[vault] createConfigPoolAndSwap() step 12: swap instruction built");

  console.log("[vault] createConfigPoolAndSwap() step 13: build atomic transaction");
  const atomicTx = new Transaction();
  atomicTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }));
  for (const ix of configAndPoolTx.instructions) {
    atomicTx.add(ix);
  }
  atomicTx.add(swapIx);
  console.log("[vault] createConfigPoolAndSwap() atomicTx instructions:", atomicTx.instructions.length);

  console.log("[vault] createConfigPoolAndSwap() step 14: send and confirm transaction");
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const txSig = await provider.sendAndConfirm(atomicTx, [config, baseMint], {
    skipPreflight: true,
  });
  console.log("[vault] createConfigPoolAndSwap() step 15: tx confirmed:", txSig);

  console.log("[vault] createConfigPoolAndSwap() step 16: fetch pool quote progress");
  let poolQuoteProgress: number | null = null;
  try {
    const poolAccount = await client.state.getPoolByBaseMint(baseMint.publicKey);
    const actualPoolPda = poolAccount?.publicKey ?? poolPda;
    console.log("[vault] createConfigPoolAndSwap() poolAccount:", poolAccount?.publicKey?.toBase58(), "actualPoolPda:", actualPoolPda.toBase58());
    poolQuoteProgress = await client.state.getPoolQuoteTokenCurveProgress(actualPoolPda);
    console.log("[vault] createConfigPoolAndSwap() poolQuoteProgress:", poolQuoteProgress);
  } catch (err) {
    console.warn("[vault] createConfigPoolAndSwap() failed to fetch pool progress:", err);
  }

  console.log("[vault] createConfigPoolAndSwap() step 17: done, returning");
  return {
    tx: txSig,
    link: solscanLink(txSig, params.network),
    configPubkey: config.publicKey.toBase58(),
    baseMintPubkey: baseMint.publicKey.toBase58(),
    poolQuoteProgress,
  };
}
