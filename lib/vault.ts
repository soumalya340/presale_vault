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
} from '@solana/web3.js';
import { AnchorProvider, Program, BN } from '@coral-xyz/anchor';
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
} from '@solana/spl-token';
import type { AnchorWallet } from '@solana/wallet-adapter-react';
import IDL from '../idl/staking_vault.json';

// ─── Constants ───────────────────────────────────────────────────────────────

export const DEPLOYER_ADDRESS = new PublicKey('cyaibXfQvCC4qKDYNguU4mXryhKjSkszPWkd56KFkrF');
const PROGRAM_ID = new PublicKey((IDL as { address: string }).address);
const NATIVE_MINT_ADDRESS = 'So11111111111111111111111111111111111111112';

export const DBC_PROGRAM_ID = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN');

// ─── PDA Utilities ───────────────────────────────────────────────────────────

export function getGlobalStatePda(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('staking_vault'), DEPLOYER_ADDRESS.toBuffer()],
    PROGRAM_ID
  );
  return pda;
}

export function getCampaignPda(campaignId: number | BN): PublicKey {
  const idBn = BN.isBN(campaignId) ? campaignId : new BN(campaignId);
  const campaignIdBuf = idBn.toArrayLike(Buffer, 'le', 8);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('campaign'), DEPLOYER_ADDRESS.toBuffer(), campaignIdBuf],
    PROGRAM_ID
  );
  return pda;
}

export function getUserDepositPda(campaignPda: PublicKey, userPubkey: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('user_deposit'), campaignPda.toBuffer(), userPubkey.toBuffer()],
    PROGRAM_ID
  );
  return pda;
}

export function getClaimPda(campaignPda: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('claim'), campaignPda.toBuffer()],
    PROGRAM_ID
  );
  return pda;
}

export function derivePoolPdas(configPk: PublicKey, baseMint: PublicKey, quoteMint: PublicKey) {
  const cmp = Buffer.compare(baseMint.toBuffer(), quoteMint.toBuffer());
  const maxKey = cmp > 0 ? baseMint : quoteMint;
  const minKey = cmp > 0 ? quoteMint : baseMint;

  const [poolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('pool'), configPk.toBuffer(), maxKey.toBuffer(), minKey.toBuffer()],
    DBC_PROGRAM_ID
  );
  const [baseVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('token_vault'), baseMint.toBuffer(), poolPda.toBuffer()],
    DBC_PROGRAM_ID
  );
  const [quoteVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('token_vault'), quoteMint.toBuffer(), poolPda.toBuffer()],
    DBC_PROGRAM_ID
  );
  const [poolAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from('pool_authority')],
    DBC_PROGRAM_ID
  );
  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from('__event_authority')],
    DBC_PROGRAM_ID
  );
  return { poolPda, baseVaultPda, quoteVaultPda, poolAuthority, eventAuthority };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function getReadOnlyProgram(connection: Connection): Program {
  const dummyWallet = {
    publicKey: new PublicKey('11111111111111111111111111111111'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signTransaction: async (tx: any) => tx,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signAllTransactions: async (txs: any[]) => txs,
  };
  const provider = new AnchorProvider(connection, dummyWallet as AnchorWallet, {
    commitment: 'confirmed',
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Program(IDL as any, provider);
}

function getProgram(connection: Connection, wallet: AnchorWallet): Program {
  const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Program(IDL as any, provider);
}

function solscanLink(tx: string, network: 'devnet' | 'mainnet'): string {
  return network === 'devnet'
    ? `https://solscan.io/tx/${tx}?cluster=devnet`
    : `https://solscan.io/tx/${tx}`;
}

// ─── Fetch campaign account with fallback for older schema ───────────────────

async function fetchCampaignAccount(
  program: Program,
  connection: Connection,
  campaignPda: PublicKey
) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await (program.account as any).campaign.fetch(campaignPda);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('buffer length') || msg.includes('beyond buffer')) {
      const info = await connection.getAccountInfo(campaignPda);
      if (!info) throw new Error(`Campaign account not found at ${campaignPda.toBase58()}`);
      return parseCampaignRaw(Buffer.from(info.data));
    }
    throw err;
  }
}

// ─── View: Global State ───────────────────────────────────────────────────────

export async function viewGlobalState(connection: Connection) {
  const program = getReadOnlyProgram(connection);
  const globalStatePda = getGlobalStatePda();

  const info = await connection.getAccountInfo(globalStatePda);
  if (!info) throw new Error('Global state account not initialized yet.');
  if (!info.owner.equals(PROGRAM_ID)) {
    throw new Error('Account is not owned by the staking vault program.');
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await (program.account as any).globalState.fetch(globalStatePda);
    return {
      globalStatePda: globalStatePda.toBase58(),
      treasuryAdmin: data.treasuryAdmin.toBase58(),
      depositFees: data.depositFees.toString(),
      withdrawFees: data.withdrawFees.toString(),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('buffer length') || msg.includes('beyond buffer')) {
      throw new Error(
        'Account data does not match expected schema (possible IDL/program version mismatch). ' +
          'Ensure the IDL matches the deployed program.'
      );
    }
    throw err;
  }
}

// ─── Manual campaign deserializer (handles accounts created before snapshot fields) ──

function parseCampaignRaw(data: Buffer) {
  let offset = 8; // skip 8-byte Anchor discriminator

  const admin = new PublicKey(data.slice(offset, offset + 32)); offset += 32;
  const campaignId = new BN(data.slice(offset, offset + 8), 'le'); offset += 8;

  const nameLen = data.readUInt32LE(offset); offset += 4;
  const campaignName = data.slice(offset, offset + nameLen).toString('utf8'); offset += nameLen;

  const depositMint = new PublicKey(data.slice(offset, offset + 32)); offset += 32;
  const vaultDepositAta = new PublicKey(data.slice(offset, offset + 32)); offset += 32;
  const endTime = new BN(data.slice(offset, offset + 8), 'le'); offset += 8;
  const totalDeposits = new BN(data.slice(offset, offset + 8), 'le'); offset += 8;
  const bump = data[offset]; offset += 1;
  const totalUsers = new BN(data.slice(offset, offset + 8), 'le'); offset += 8;
  const activeStatus = data[offset] !== 0; offset += 1;
  const withdrawEnabled = data[offset] !== 0; offset += 1;
  const claimMint = new PublicKey(data.slice(offset, offset + 32)); offset += 32;
  const vaultClaimAta = new PublicKey(data.slice(offset, offset + 32)); offset += 32;
  const claimStatus = data[offset] !== 0; offset += 1;

  // These fields were added in a later program version — default to 0 if absent.
  const snapshotTotalDeposits = offset + 8 <= data.length
    ? new BN(data.slice(offset, offset + 8), 'le')
    : new BN(0);
  offset += 8;
  const snapshotTotalClaim = offset + 8 <= data.length
    ? new BN(data.slice(offset, offset + 8), 'le')
    : new BN(0);

  return {
    admin, campaignId, campaignName, depositMint, vaultDepositAta,
    endTime, totalDeposits, bump, totalUsers, activeStatus, withdrawEnabled,
    claimMint, vaultClaimAta, claimStatus, snapshotTotalDeposits, snapshotTotalClaim,
  };
}

// ─── View: Campaign ───────────────────────────────────────────────────────────

export async function viewCampaign(connection: Connection, campaignId: number) {
  const program = getReadOnlyProgram(connection);
  const campaignPda = getCampaignPda(campaignId);

  const info = await connection.getAccountInfo(campaignPda);
  if (!info) throw new Error(`Campaign ${campaignId} not found. The account does not exist.`);
  if (!info.owner.equals(PROGRAM_ID)) {
    throw new Error('Account is not owned by the staking vault program.');
  }

  const account = await fetchCampaignAccount(program, connection, campaignPda);
  const defaultPubkey = '11111111111111111111111111111111';

  const endTimeBn = BN.isBN(account.endTime) ? account.endTime : new BN(account.endTime);
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
    campaignName: account.campaignName ?? '(not set)',
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
        : '(not set)',
    vaultClaimAta:
      account.vaultClaimAta && account.vaultClaimAta.toBase58() !== defaultPubkey
        ? account.vaultClaimAta.toBase58()
        : '(not set)',
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
  userPubkey: string
) {
  const program = getReadOnlyProgram(connection);
  const user = new PublicKey(userPubkey);
  const campaignPda = getCampaignPda(campaignId);
  const userDepositPda = getUserDepositPda(campaignPda, user);

  const info = await connection.getAccountInfo(userDepositPda);
  if (!info) throw new Error('No deposit record found for this user in this campaign.');
  if (!info.owner.equals(PROGRAM_ID)) {
    throw new Error('Account is not owned by the staking vault program.');
  }

  let data;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data = await (program.account as any).userDeposit.fetch(userDepositPda);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('buffer length') || msg.includes('beyond buffer')) {
      throw new Error(
        'User deposit data does not match expected schema (possible IDL/program version mismatch).'
      );
    }
    throw err;
  }
  return {
    campaignPda: campaignPda.toBase58(),
    userDepositPda: userDepositPda.toBase58(),
    userIdPerCampaign: data.userIdPerCampaign.toString(),
    user: data.user.toBase58(),
    amount: data.amount.toString(),
  };
}

// ─── User: Deposit ────────────────────────────────────────────────────────────

export async function deposit(
  connection: Connection,
  wallet: AnchorWallet,
  params: { depositMint: string; campaignId: number; amount: string; network: 'devnet' | 'mainnet' }
): Promise<{ tx: string; link: string }> {
  const program = getProgram(connection, wallet);
  const depositMint = new PublicKey(params.depositMint);
  const campaignId = new BN(params.campaignId);
  const isNativeSol = depositMint.toBase58() === NATIVE_MINT_ADDRESS;

  const campaignPda = getCampaignPda(campaignId);
  const globalStatePda = getGlobalStatePda();

  const campaignAccount = await fetchCampaignAccount(program, connection, campaignPda);
  const vaultDepositAta: PublicKey = campaignAccount.vaultDepositAta;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const globalState = await (program.account as any).globalState.fetch(globalStatePda);
  const treasuryAdmin: PublicKey = globalState.treasuryAdmin;

  const treasuryDepositAta = getAssociatedTokenAddressSync(
    depositMint, treasuryAdmin, false, TOKEN_PROGRAM_ID
  );

  let amount: BN;
  let userDepositAta: PublicKey;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const preInstructions: any[] = [];

  if (isNativeSol) {
    const solAmount = parseFloat(params.amount);
    amount = new BN(Math.round(solAmount * LAMPORTS_PER_SOL));
    userDepositAta = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey, false, TOKEN_PROGRAM_ID);

    // Idempotent ATA creation + wrap SOL
    preInstructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey, userDepositAta, wallet.publicKey, NATIVE_MINT
      )
    );
    preInstructions.push(
      SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: userDepositAta, lamports: amount.toNumber() })
    );
    preInstructions.push(createSyncNativeInstruction(userDepositAta, TOKEN_PROGRAM_ID));
  } else {
    amount = new BN(params.amount);
    userDepositAta = getAssociatedTokenAddressSync(depositMint, wallet.publicKey, false, TOKEN_PROGRAM_ID);
  }

  // Ensure treasury ATA exists
  const treasuryInfo = await connection.getAccountInfo(treasuryDepositAta);
  if (!treasuryInfo) {
    preInstructions.push(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey, treasuryDepositAta, treasuryAdmin, depositMint
      )
    );
  }

  const userDepositPda = getUserDepositPda(campaignPda, wallet.publicKey);

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
    network: 'devnet' | 'mainnet';
  }
): Promise<{ tx: string; link: string; unwrapTx?: string }> {
  const program = getProgram(connection, wallet);
  const depositMint = new PublicKey(params.depositMint);
  const campaignId = new BN(params.campaignId);
  const isNativeSol = depositMint.toBase58() === NATIVE_MINT_ADDRESS;

  const campaignPda = getCampaignPda(campaignId);
  const globalStatePda = getGlobalStatePda();

  const campaignAccount = await fetchCampaignAccount(program, connection, campaignPda);
  const vaultDepositAta: PublicKey = campaignAccount.vaultDepositAta;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const globalState = await (program.account as any).globalState.fetch(globalStatePda);
  const treasuryAdmin: PublicKey = globalState.treasuryAdmin;

  const treasuryDepositAta = getAssociatedTokenAddressSync(
    depositMint, treasuryAdmin, false, TOKEN_PROGRAM_ID
  );

  let amount: BN;
  let userDepositAta: PublicKey;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const preInstructions: any[] = [];

  if (isNativeSol) {
    const solAmount = parseFloat(params.amount);
    amount = new BN(Math.round(solAmount * LAMPORTS_PER_SOL));
    userDepositAta = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey, false, TOKEN_PROGRAM_ID);
    preInstructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey, userDepositAta, wallet.publicKey, NATIVE_MINT
      )
    );
  } else {
    amount = new BN(params.amount);
    userDepositAta = getAssociatedTokenAddressSync(depositMint, wallet.publicKey, false, TOKEN_PROGRAM_ID);
    preInstructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey, userDepositAta, wallet.publicKey, depositMint
      )
    );
  }

  // Ensure treasury ATA exists
  const treasuryInfo = await connection.getAccountInfo(treasuryDepositAta);
  if (!treasuryInfo) {
    preInstructions.push(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey, treasuryDepositAta, treasuryAdmin, depositMint
      )
    );
  }

  const userDepositPda = getUserDepositPda(campaignPda, wallet.publicKey);

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
    const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
    const { Transaction } = await import('@solana/web3.js');
    const unwrapTxSig = await provider.sendAndConfirm(
      new Transaction().add(
        createCloseAccountInstruction(
          userDepositAta, wallet.publicKey, wallet.publicKey, [], TOKEN_PROGRAM_ID
        )
      )
    );
    return { tx, link: solscanLink(tx, params.network), unwrapTx: unwrapTxSig };
  }

  return { tx, link: solscanLink(tx, params.network) };
}

// ─── User: Claim ──────────────────────────────────────────────────────────────

export async function userClaim(
  connection: Connection,
  wallet: AnchorWallet,
  params: { campaignId: number; useToken2022: boolean; network: 'devnet' | 'mainnet' }
): Promise<{ tx: string; link: string }> {
  const program = getProgram(connection, wallet);
  const campaignId = new BN(params.campaignId);
  const claimTokenProgram = params.useToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

  const campaignPda = getCampaignPda(campaignId);
  const campaignAccount = await fetchCampaignAccount(program, connection, campaignPda);
  const claimMint: PublicKey = campaignAccount.claimMint;
  const vaultClaimAta: PublicKey = campaignAccount.vaultClaimAta;

  const defaultPubkey = '11111111111111111111111111111111';
  if (claimMint.toBase58() === defaultPubkey) {
    throw new Error('Claim mint not set on campaign. Run swap or load_claim_tokens first.');
  }

  const userDepositPda = getUserDepositPda(campaignPda, wallet.publicKey);
  const userClaimAta = getAssociatedTokenAddressSync(claimMint, wallet.publicKey, false, claimTokenProgram);

  const preInstructions = [];
  const userClaimAtaInfo = await connection.getAccountInfo(userClaimAta);
  if (!userClaimAtaInfo) {
    preInstructions.push(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey, userClaimAta, wallet.publicKey, claimMint, claimTokenProgram
      )
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

  return { tx, link: solscanLink(tx, params.network) };
}

// ─── Admin: Initialize Global State ──────────────────────────────────────────

export async function initializeGlobalState(
  connection: Connection,
  wallet: AnchorWallet,
  params: { network: 'devnet' | 'mainnet' }
): Promise<{ tx: string; link: string }> {
  const program = getProgram(connection, wallet);
  const globalStatePda = getGlobalStatePda();

  const existing = await connection.getAccountInfo(globalStatePda);
  if (existing) throw new Error('Global state already initialized.');

  const tx = await program.methods
    .initializeGlobalState(new BN(10), new BN(5))
    .accounts({
      deployer: wallet.publicKey,
      treasuryAdmin: wallet.publicKey,
      globalState: globalStatePda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

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
    network: 'devnet' | 'mainnet';
  }
): Promise<{ tx: string; link: string }> {
  const program = getProgram(connection, wallet);
  const depositMint = new PublicKey(params.depositMint);
  const campaignId = new BN(params.campaignId);
  const duration = new BN(params.durationSeconds);

  const campaignPda = getCampaignPda(campaignId);
  const globalStatePda = getGlobalStatePda();
  const vaultDepositAta = getAssociatedTokenAddressSync(depositMint, campaignPda, true, TOKEN_PROGRAM_ID);

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

  return { tx, link: solscanLink(tx, params.network) };
}

// ─── Admin: Update Fees ───────────────────────────────────────────────────────

export async function updateFees(
  connection: Connection,
  wallet: AnchorWallet,
  params: { depositFeeBps: number; withdrawFeeBps: number; network: 'devnet' | 'mainnet' }
): Promise<{ tx: string; link: string }> {
  const program = getProgram(connection, wallet);
  const globalStatePda = getGlobalStatePda();

  const tx = await program.methods
    .updateFees(new BN(params.depositFeeBps), new BN(params.withdrawFeeBps))
    .accounts({ deployer: wallet.publicKey, globalState: globalStatePda })
    .rpc();

  return { tx, link: solscanLink(tx, params.network) };
}

// ─── Admin: Set Treasury Admin ────────────────────────────────────────────────

export async function setTreasuryAdmin(
  connection: Connection,
  wallet: AnchorWallet,
  params: { newTreasuryAdmin: string; network: 'devnet' | 'mainnet' }
): Promise<{ tx: string; link: string }> {
  const program = getProgram(connection, wallet);
  const globalStatePda = getGlobalStatePda();
  const newAdmin = new PublicKey(params.newTreasuryAdmin);

  const tx = await program.methods
    .setTreasuryAdmin(newAdmin)
    .accounts({ deployer: wallet.publicKey, globalState: globalStatePda })
    .rpc();

  return { tx, link: solscanLink(tx, params.network) };
}

// ─── Admin: Set Active Status ─────────────────────────────────────────────────

export async function setActiveStatus(
  connection: Connection,
  wallet: AnchorWallet,
  params: { campaignId: number; status: boolean; network: 'devnet' | 'mainnet' }
): Promise<{ tx: string; link: string }> {
  const program = getProgram(connection, wallet);
  const campaignPda = getCampaignPda(params.campaignId);

  const tx = await program.methods
    .setActiveStatus(params.status)
    .accounts({ admin: wallet.publicKey, campaign: campaignPda })
    .rpc();

  return { tx, link: solscanLink(tx, params.network) };
}

// ─── Admin: Set Withdraw Enabled ──────────────────────────────────────────────

export async function setWithdrawEnabled(
  connection: Connection,
  wallet: AnchorWallet,
  params: { campaignId: number; enabled: boolean; network: 'devnet' | 'mainnet' }
): Promise<{ tx: string; link: string }> {
  const program = getProgram(connection, wallet);
  const campaignPda = getCampaignPda(params.campaignId);

  const tx = await program.methods
    .setWithdrawEnabled(params.enabled)
    .accounts({ admin: wallet.publicKey, campaign: campaignPda })
    .rpc();

  return { tx, link: solscanLink(tx, params.network) };
}

// ─── Admin: Set Claim Status ──────────────────────────────────────────────────

export async function setClaimStatus(
  connection: Connection,
  wallet: AnchorWallet,
  params: { campaignId: number; status: boolean; network: 'devnet' | 'mainnet' }
): Promise<{ tx: string; link: string }> {
  const program = getProgram(connection, wallet);
  const campaignPda = getCampaignPda(params.campaignId);

  const tx = await program.methods
    .setClaimStatus(params.status)
    .accounts({ admin: wallet.publicKey, campaign: campaignPda })
    .rpc();

  return { tx, link: solscanLink(tx, params.network) };
}

// ─── Admin: Load Claim Tokens ─────────────────────────────────────────────────

export async function loadClaimTokens(
  connection: Connection,
  wallet: AnchorWallet,
  params: { campaignId: number; claimMint: string; amount: string; network: 'devnet' | 'mainnet' }
): Promise<{ tx: string; link: string }> {
  const program = getProgram(connection, wallet);
  const campaignId = new BN(params.campaignId);
  const claimMint = new PublicKey(params.claimMint);
  const amount = new BN(params.amount);

  const campaignPda = getCampaignPda(campaignId);
  const vaultClaimAta = getAssociatedTokenAddressSync(claimMint, campaignPda, true, TOKEN_PROGRAM_ID);
  const adminClaimAta = getAssociatedTokenAddressSync(claimMint, wallet.publicKey, false, TOKEN_PROGRAM_ID);

  // Ensure admin ATA exists
  const preInstructions = [];
  const adminAtaInfo = await connection.getAccountInfo(adminClaimAta);
  if (!adminAtaInfo) {
    preInstructions.push(
      createAssociatedTokenAccountInstruction(wallet.publicKey, adminClaimAta, wallet.publicKey, claimMint)
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
    network: 'devnet' | 'mainnet';
  }
): Promise<{ tx: string; link: string }> {
  const program = getProgram(connection, wallet);
  const campaignId = new BN(params.campaignId);
  const minimumAmountOut = new BN(params.minimumAmountOut);
  const configPubkey = new PublicKey(params.configPubkey);
  const outputMint = new PublicKey(params.outputMint);

  const campaignPda = getCampaignPda(campaignId);
  const campaignAccount = await fetchCampaignAccount(program, connection, campaignPda);
  const quoteMint: PublicKey = campaignAccount.depositMint;
  const vaultDepositAta: PublicKey = campaignAccount.vaultDepositAta;

  const tokenBaseProgram = params.useToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const tokenQuoteProgram = TOKEN_PROGRAM_ID;
  const tokenProgram = params.useToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

  const { poolPda, baseVaultPda, quoteVaultPda, poolAuthority, eventAuthority } = derivePoolPdas(
    configPubkey, outputMint, quoteMint
  );

  const outputTokenAccount = getAssociatedTokenAddressSync(
    outputMint, campaignPda, true, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID
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
      eventAuthority,
      dbcProgram: DBC_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  return { tx, link: solscanLink(tx, params.network) };
}

// ─── Admin: Admin Withdraw ────────────────────────────────────────────────────

export async function adminWithdraw(
  connection: Connection,
  wallet: AnchorWallet,
  params: { campaignId: number; amount: string; network: 'devnet' | 'mainnet' }
): Promise<{ tx: string; link: string }> {
  const program = getProgram(connection, wallet);
  const campaignId = new BN(params.campaignId);

  const campaignPda = getCampaignPda(campaignId);
  const globalStatePda = getGlobalStatePda();

  const campaignAccount = await fetchCampaignAccount(program, connection, campaignPda);
  const depositMint: PublicKey = campaignAccount.depositMint;
  const vaultDepositAta: PublicKey = campaignAccount.vaultDepositAta;
  const isNativeSol = depositMint.toBase58() === NATIVE_MINT_ADDRESS;

  let amount: BN;
  if (isNativeSol) {
    amount = new BN(Math.round(parseFloat(params.amount) * LAMPORTS_PER_SOL));
  } else {
    amount = new BN(params.amount);
  }

  const treasuryDepositAta = getAssociatedTokenAddressSync(depositMint, wallet.publicKey, false, TOKEN_PROGRAM_ID);
  const preInstructions = [];
  const ataInfo = await connection.getAccountInfo(treasuryDepositAta);
  if (!ataInfo) {
    preInstructions.push(
      createAssociatedTokenAccountInstruction(wallet.publicKey, treasuryDepositAta, wallet.publicKey, depositMint)
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

  return { tx, link: solscanLink(tx, params.network) };
}

// ─── Admin: Change Campaign Admin ─────────────────────────────────────────────

export async function changeCampaignAdmin(
  connection: Connection,
  wallet: AnchorWallet,
  params: { campaignId: number; newAdmin: string; network: 'devnet' | 'mainnet' }
): Promise<{ tx: string; link: string }> {
  const program = getProgram(connection, wallet);
  const campaignPda = getCampaignPda(params.campaignId);
  const newAdmin = new PublicKey(params.newAdmin);

  const tx = await program.methods
    .changeCampaignAdmin(newAdmin)
    .accounts({ deployer: wallet.publicKey, campaign: campaignPda })
    .rpc();

  return { tx, link: solscanLink(tx, params.network) };
}

// ─── Admin: Update Campaign Duration ─────────────────────────────────────────

export async function updateCampaignDuration(
  connection: Connection,
  wallet: AnchorWallet,
  params: { campaignId: number; newDurationSeconds: number; network: 'devnet' | 'mainnet' }
): Promise<{ tx: string; link: string }> {
  const program = getProgram(connection, wallet);
  const campaignPda = getCampaignPda(params.campaignId);

  const tx = await program.methods
    .updateCampaignDuration(new BN(params.newDurationSeconds))
    .accounts({ admin: wallet.publicKey, campaign: campaignPda })
    .rpc();

  return { tx, link: solscanLink(tx, params.network) };
}
