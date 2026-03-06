'use client';

import { useState } from 'react';
import { useConnection, useWallet, useAnchorWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import {
  viewGlobalState,
  viewCampaign,
  viewUserState,
  deposit,
  withdraw,
  userClaim,
  initializeGlobalState,
  initializeCampaign,
  updateFees,
  setTreasuryAdmin,
  setActiveStatus,
  setWithdrawEnabled,
  setClaimStatus,
  loadClaimTokens,
  swap,
  adminWithdraw,
  changeCampaignAdmin,
  updateCampaignDuration,
} from '@/lib/vault';

// ─── Types ──────────────────────────────────────────────────────────────────

type Network = 'devnet' | 'mainnet';
type SectionId = 'view' | 'user' | 'admin';

interface FieldDef {
  name: string;
  label: string;
  placeholder?: string;
  type?: 'text' | 'number' | 'select';
  options?: { label: string; value: string }[];
  hint?: string;
}

interface FunctionDef {
  id: string;
  number: string;
  title: string;
  description: string;
  fields: FieldDef[];
  submitLabel: string;
}

// ─── Data ───────────────────────────────────────────────────────────────────

const VIEW_FUNCTIONS: FunctionDef[] = [
  {
    id: 'view_global_state',
    number: '1A',
    title: 'View Global State',
    description: 'Fetch the global state PDA — treasury admin address, deposit fees, and withdraw fees.',
    fields: [],
    submitLabel: 'Fetch Global State',
  },
  {
    id: 'view_campaign',
    number: '1B',
    title: 'View Campaign',
    description: 'Fetch all on-chain data for a specific campaign by ID.',
    fields: [
      { name: 'campaign_id', label: 'Campaign ID', placeholder: '1', type: 'number', hint: 'Numeric campaign identifier' },
    ],
    submitLabel: 'Fetch Campaign',
  },
  {
    id: 'view_user_state',
    number: '1C',
    title: 'View User Deposit',
    description: "View a specific user's deposit record for a campaign.",
    fields: [
      { name: 'campaign_id', label: 'Campaign ID', placeholder: '1', type: 'number' },
      { name: 'user_pubkey', label: 'User Public Key', placeholder: 'Enter Solana wallet address' },
    ],
    submitLabel: 'Fetch User Deposit',
  },
];

const USER_FUNCTIONS: FunctionDef[] = [
  {
    id: 'deposit',
    number: '2A',
    title: 'Deposit',
    description:
      'Deposit tokens into a campaign vault. For native SOL enter the SOL amount (e.g. 0.5); for SPL tokens enter raw smallest-unit amount.',
    fields: [
      { name: 'deposit_mint', label: 'Deposit Mint', placeholder: 'So11111111111111111111111111111111111111112', hint: 'Token mint address. Use native SOL mint for wSOL deposits.' },
      { name: 'campaign_id', label: 'Campaign ID', placeholder: '1', type: 'number' },
      { name: 'amount', label: 'Amount', placeholder: '0.5', hint: 'SOL amount (e.g. 0.5) for native SOL, or raw token units for SPL' },
    ],
    submitLabel: 'Deposit',
  },
  {
    id: 'withdraw',
    number: '2B',
    title: 'Withdraw',
    description: 'Withdraw tokens from a campaign vault back to your wallet. Optionally unwrap wSOL to native SOL.',
    fields: [
      { name: 'deposit_mint', label: 'Deposit Mint', placeholder: 'So11111111111111111111111111111111111111112' },
      { name: 'campaign_id', label: 'Campaign ID', placeholder: '1', type: 'number' },
      { name: 'amount', label: 'Amount', placeholder: '0.5', hint: 'SOL amount or raw token units' },
      {
        name: 'unwrap',
        label: 'Unwrap wSOL to SOL',
        type: 'select',
        options: [
          { label: 'No', value: 'false' },
          { label: 'Yes (--unwrap)', value: 'true' },
        ],
      },
    ],
    submitLabel: 'Withdraw',
  },
  {
    id: 'user_claim',
    number: '2C',
    title: 'Claim Tokens',
    description: 'Claim allocated tokens from the vault after the campaign ends.',
    fields: [
      { name: 'campaign_id', label: 'Campaign ID', placeholder: '1', type: 'number' },
      {
        name: 'use_token_2022',
        label: 'Token Standard',
        type: 'select',
        options: [
          { label: 'SPL Token (default)', value: 'false' },
          { label: 'Token-2022', value: 'true' },
        ],
        hint: 'Select Token-2022 if the claim mint uses the Token-2022 program',
      },
    ],
    submitLabel: 'Claim Tokens',
  },
];

const ADMIN_FUNCTIONS: FunctionDef[] = [
  {
    id: 'initialize_global_state',
    number: '3A',
    title: 'Initialize Global State',
    description: 'One-time initialization of the global state PDA. Run this only once after deployment.',
    fields: [],
    submitLabel: 'Initialize Global State',
  },
  {
    id: 'initialize_campaign',
    number: '3B',
    title: 'Initialize Campaign',
    description: 'Create a new campaign with a deposit mint, ID, name, and duration.',
    fields: [
      { name: 'deposit_mint', label: 'Deposit Mint', placeholder: 'Token mint address' },
      { name: 'campaign_id', label: 'Campaign ID', placeholder: '1', type: 'number' },
      { name: 'campaign_name', label: 'Campaign Name', placeholder: 'e.g. CyreneAI Early Sale Round 1' },
      { name: 'duration_seconds', label: 'Duration (seconds)', placeholder: '86400', type: 'number', hint: 'Default: 86400 (1 day)' },
    ],
    submitLabel: 'Initialize Campaign',
  },
  {
    id: 'update_fees',
    number: '3C',
    title: 'Update Fees',
    description: 'Update deposit and withdraw fee rates in basis points (bps). 100 bps = 1%.',
    fields: [
      { name: 'deposit_fee_bps', label: 'Deposit Fee (bps)', placeholder: '50', type: 'number', hint: '50 = 0.5%' },
      { name: 'withdraw_fee_bps', label: 'Withdraw Fee (bps)', placeholder: '50', type: 'number', hint: '50 = 0.5%' },
    ],
    submitLabel: 'Update Fees',
  },
  {
    id: 'set_treasury_admin',
    number: '3D',
    title: 'Set Treasury Admin',
    description: 'Transfer treasury admin authority to a new public key.',
    fields: [
      { name: 'new_treasury_admin', label: 'New Treasury Admin Pubkey', placeholder: 'New admin wallet address' },
    ],
    submitLabel: 'Set Treasury Admin',
  },
  {
    id: 'set_active_status',
    number: '3E',
    title: 'Set Active Status',
    description: 'Enable or disable a campaign for deposits.',
    fields: [
      { name: 'campaign_id', label: 'Campaign ID', placeholder: '1', type: 'number' },
      {
        name: 'status',
        label: 'Active Status',
        type: 'select',
        options: [
          { label: 'Active (true)', value: 'true' },
          { label: 'Inactive (false)', value: 'false' },
        ],
      },
    ],
    submitLabel: 'Set Active Status',
  },
  {
    id: 'set_withdraw_enabled',
    number: '3F',
    title: 'Set Withdraw Enabled',
    description: 'Enable or disable withdrawals for a campaign.',
    fields: [
      { name: 'campaign_id', label: 'Campaign ID', placeholder: '1', type: 'number' },
      {
        name: 'enabled',
        label: 'Withdraw Enabled',
        type: 'select',
        options: [
          { label: 'Enabled (true)', value: 'true' },
          { label: 'Disabled (false)', value: 'false' },
        ],
      },
    ],
    submitLabel: 'Set Withdraw Enabled',
  },
  {
    id: 'set_claim_status',
    number: '3G',
    title: 'Set Claim Status',
    description: 'Enable or disable the claim phase for a campaign.',
    fields: [
      { name: 'campaign_id', label: 'Campaign ID', placeholder: '1', type: 'number' },
      {
        name: 'status',
        label: 'Claim Status',
        type: 'select',
        options: [
          { label: 'Enabled (true)', value: 'true' },
          { label: 'Disabled (false)', value: 'false' },
        ],
      },
    ],
    submitLabel: 'Set Claim Status',
  },
  {
    id: 'load_claim_tokens',
    number: '3H',
    title: 'Load Claim Tokens',
    description: 'Load claim tokens into the vault for user distribution.',
    fields: [
      { name: 'campaign_id', label: 'Campaign ID', placeholder: '1', type: 'number' },
      { name: 'claim_mint', label: 'Claim Mint', placeholder: 'Claim token mint address' },
      { name: 'amount', label: 'Amount (raw units)', placeholder: '1000000000', type: 'number' },
    ],
    submitLabel: 'Load Claim Tokens',
  },
  {
    id: 'swap',
    number: '3I',
    title: 'Swap',
    description: 'Execute a swap from the vault deposit tokens to the claim token via a pool.',
    fields: [
      { name: 'campaign_id', label: 'Campaign ID', placeholder: '1', type: 'number' },
      { name: 'minimum_amount_out', label: 'Minimum Amount Out (raw)', placeholder: '0', type: 'number' },
      { name: 'config_pubkey', label: 'Config Pubkey', placeholder: 'Pool config account address' },
      { name: 'output_mint', label: 'Output Mint', placeholder: 'Output token mint address' },
      {
        name: 'use_token_2022',
        label: 'Output Token Standard',
        type: 'select',
        options: [
          { label: 'SPL Token (default)', value: 'false' },
          { label: 'Token-2022', value: 'true' },
        ],
      },
    ],
    submitLabel: 'Execute Swap',
  },
  {
    id: 'admin_withdraw',
    number: '3J',
    title: 'Admin Withdraw',
    description: 'Admin emergency withdrawal of tokens from the campaign vault.',
    fields: [
      { name: 'campaign_id', label: 'Campaign ID', placeholder: '1', type: 'number' },
      { name: 'amount', label: 'Amount', placeholder: '0.5', hint: 'SOL amount or raw token units' },
    ],
    submitLabel: 'Admin Withdraw',
  },
  {
    id: 'change_campaign_admin',
    number: '3K',
    title: 'Change Campaign Admin',
    description: 'Transfer campaign admin authority to a different wallet.',
    fields: [
      { name: 'campaign_id', label: 'Campaign ID', placeholder: '1', type: 'number' },
      { name: 'new_admin', label: 'New Admin Pubkey', placeholder: 'New admin wallet address' },
    ],
    submitLabel: 'Change Admin',
  },
  {
    id: 'update_campaign_duration',
    number: '3L',
    title: 'Update Campaign Duration',
    description: 'Extend or change the end time of a campaign.',
    fields: [
      { name: 'campaign_id', label: 'Campaign ID', placeholder: '1', type: 'number' },
      { name: 'new_duration_seconds', label: 'New Duration (seconds)', placeholder: '172800', type: 'number', hint: '172800 = 2 days from now' },
    ],
    submitLabel: 'Update Duration',
  },
];

// ─── Section colors ──────────────────────────────────────────────────────────

const SECTION_STYLE: Record<SectionId, { badge: string; accent: string; glow: string }> = {
  view:  { badge: 'bg-cyan-900/60 text-cyan-300 border-cyan-700/50',  accent: '#06b6d4', glow: 'rgba(6,182,212,0.15)' },
  user:  { badge: 'bg-violet-900/60 text-violet-300 border-violet-700/50', accent: '#8b5cf6', glow: 'rgba(139,92,246,0.15)' },
  admin: { badge: 'bg-rose-900/60 text-rose-300 border-rose-700/50',  accent: '#f43f5e', glow: 'rgba(244,63,94,0.15)' },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Determines which functions require a connected wallet
const REQUIRES_WALLET = new Set([
  'deposit', 'withdraw', 'user_claim',
  'initialize_global_state', 'initialize_campaign', 'update_fees',
  'set_treasury_admin', 'set_active_status', 'set_withdraw_enabled',
  'set_claim_status', 'load_claim_tokens', 'swap', 'admin_withdraw',
  'change_campaign_admin', 'update_campaign_duration',
]);

function formatResult(data: unknown): string {
  if (typeof data === 'string') return data;
  return JSON.stringify(data, null, 2);
}

// ─── Accordion Item ───────────────────────────────────────────────────────────

function AccordionItem({
  fn,
  section,
  network,
}: {
  fn: FunctionDef;
  section: SectionId;
  network: Network;
}) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ type: 'info' | 'success' | 'error'; text: string } | null>(null);
  const [loading, setLoading] = useState(false);

  const { connection } = useConnection();
  const anchorWallet = useAnchorWallet();
  const { publicKey, connected } = useWallet();
  const { setVisible } = useWalletModal();

  const style = SECTION_STYLE[section];
  const needsWallet = REQUIRES_WALLET.has(fn.id);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (needsWallet && !connected) {
      setVisible(true);
      return;
    }

    setLoading(true);
    setResult(null);

    try {
      let data: unknown;
      const net = network;

      // ── View functions (read-only, no wallet needed) ──
      if (fn.id === 'view_global_state') {
        data = await viewGlobalState(connection);
      } else if (fn.id === 'view_campaign') {
        data = await viewCampaign(connection, Number(values.campaign_id));
      } else if (fn.id === 'view_user_state') {
        data = await viewUserState(connection, Number(values.campaign_id), values.user_pubkey);
      }

      // ── User functions (wallet required) ──
      else if (fn.id === 'deposit') {
        const r = await deposit(connection, anchorWallet!, {
          depositMint: values.deposit_mint,
          campaignId: Number(values.campaign_id),
          amount: values.amount,
          network: net,
        });
        data = { tx: r.tx, solscan: r.link };
      } else if (fn.id === 'withdraw') {
        const r = await withdraw(connection, anchorWallet!, {
          depositMint: values.deposit_mint,
          campaignId: Number(values.campaign_id),
          amount: values.amount,
          unwrap: values.unwrap === 'true',
          network: net,
        });
        data = { tx: r.tx, solscan: r.link, unwrapTx: r.unwrapTx };
      } else if (fn.id === 'user_claim') {
        const r = await userClaim(connection, anchorWallet!, {
          campaignId: Number(values.campaign_id),
          useToken2022: values.use_token_2022 === 'true',
          network: net,
        });
        data = { tx: r.tx, solscan: r.link };
      }

      // ── Admin functions ──
      else if (fn.id === 'initialize_global_state') {
        const r = await initializeGlobalState(connection, anchorWallet!, { network: net });
        data = { tx: r.tx, solscan: r.link };
      } else if (fn.id === 'initialize_campaign') {
        const r = await initializeCampaign(connection, anchorWallet!, {
          depositMint: values.deposit_mint,
          campaignId: Number(values.campaign_id),
          campaignName: values.campaign_name,
          durationSeconds: Number(values.duration_seconds) || 86400,
          network: net,
        });
        data = { tx: r.tx, solscan: r.link };
      } else if (fn.id === 'update_fees') {
        const r = await updateFees(connection, anchorWallet!, {
          depositFeeBps: Number(values.deposit_fee_bps),
          withdrawFeeBps: Number(values.withdraw_fee_bps),
          network: net,
        });
        data = { tx: r.tx, solscan: r.link };
      } else if (fn.id === 'set_treasury_admin') {
        const r = await setTreasuryAdmin(connection, anchorWallet!, {
          newTreasuryAdmin: values.new_treasury_admin,
          network: net,
        });
        data = { tx: r.tx, solscan: r.link };
      } else if (fn.id === 'set_active_status') {
        const r = await setActiveStatus(connection, anchorWallet!, {
          campaignId: Number(values.campaign_id),
          status: values.status === 'true',
          network: net,
        });
        data = { tx: r.tx, solscan: r.link };
      } else if (fn.id === 'set_withdraw_enabled') {
        const r = await setWithdrawEnabled(connection, anchorWallet!, {
          campaignId: Number(values.campaign_id),
          enabled: values.enabled === 'true',
          network: net,
        });
        data = { tx: r.tx, solscan: r.link };
      } else if (fn.id === 'set_claim_status') {
        const r = await setClaimStatus(connection, anchorWallet!, {
          campaignId: Number(values.campaign_id),
          status: values.status === 'true',
          network: net,
        });
        data = { tx: r.tx, solscan: r.link };
      } else if (fn.id === 'load_claim_tokens') {
        const r = await loadClaimTokens(connection, anchorWallet!, {
          campaignId: Number(values.campaign_id),
          claimMint: values.claim_mint,
          amount: values.amount,
          network: net,
        });
        data = { tx: r.tx, solscan: r.link };
      } else if (fn.id === 'swap') {
        const r = await swap(connection, anchorWallet!, {
          campaignId: Number(values.campaign_id),
          minimumAmountOut: values.minimum_amount_out || '0',
          configPubkey: values.config_pubkey,
          outputMint: values.output_mint,
          useToken2022: values.use_token_2022 === 'true',
          network: net,
        });
        data = { tx: r.tx, solscan: r.link };
      } else if (fn.id === 'admin_withdraw') {
        const r = await adminWithdraw(connection, anchorWallet!, {
          campaignId: Number(values.campaign_id),
          amount: values.amount,
          network: net,
        });
        data = { tx: r.tx, solscan: r.link };
      } else if (fn.id === 'change_campaign_admin') {
        const r = await changeCampaignAdmin(connection, anchorWallet!, {
          campaignId: Number(values.campaign_id),
          newAdmin: values.new_admin,
          network: net,
        });
        data = { tx: r.tx, solscan: r.link };
      } else if (fn.id === 'update_campaign_duration') {
        const r = await updateCampaignDuration(connection, anchorWallet!, {
          campaignId: Number(values.campaign_id),
          newDurationSeconds: Number(values.new_duration_seconds),
          network: net,
        });
        data = { tx: r.tx, solscan: r.link };
      }

      setResult({ type: 'success', text: formatResult(data) });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setResult({ type: 'error', text: msg });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="rounded-xl border transition-all duration-200"
      style={{
        borderColor: open ? style.accent + '55' : '#1e1e30',
        boxShadow: open ? `0 0 20px ${style.glow}` : 'none',
        background: '#0e0e1a',
      }}
    >
      {/* Header */}
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-4 px-5 py-4 text-left group"
      >
        <span
          className="flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center text-xs font-bold tracking-wide"
          style={{ background: style.accent + '22', color: style.accent, border: `1px solid ${style.accent}44` }}
        >
          {fn.number}
        </span>
        <span className="flex-1 font-semibold text-white/90 group-hover:text-white transition-colors">
          {fn.title}
        </span>
        <span
          className="flex-shrink-0 text-lg transition-transform duration-200 select-none"
          style={{ color: style.accent, transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
        >
          &#8964;
        </span>
      </button>

      {/* Body */}
      <div className={`accordion-content ${open ? 'open' : ''}`}>
        <form onSubmit={handleSubmit} className="px-5 pb-5 pt-1 space-y-4">
          {/* Description */}
          <p className="text-sm text-slate-400 leading-relaxed border-l-2 pl-3" style={{ borderColor: style.accent + '66' }}>
            {fn.description}
          </p>

          {fn.fields.length === 0 && (
            <p className="text-xs text-slate-500 italic">No parameters required.</p>
          )}

          {/* Wallet hint for write functions */}
          {needsWallet && !connected && (
            <div
              className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg"
              style={{ background: '#161626', border: '1px solid #2a2a40', color: '#94a3b8' }}
            >
              <span>Connect your wallet to execute this function.</span>
            </div>
          )}

          {/* Connected wallet badge */}
          {needsWallet && connected && publicKey && (
            <div
              className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg"
              style={{ background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.25)', color: '#a78bfa' }}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-pulse" />
              <span className="font-mono">{publicKey.toBase58().slice(0, 6)}...{publicKey.toBase58().slice(-6)}</span>
            </div>
          )}

          {/* Fields */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {fn.fields.map(field => (
              <div key={field.name}>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  {field.label}
                </label>
                {field.type === 'select' ? (
                  <select
                    value={values[field.name] ?? field.options?.[0]?.value ?? ''}
                    onChange={e => setValues(v => ({ ...v, [field.name]: e.target.value }))}
                    className="w-full rounded-lg px-3 py-2 text-sm text-white appearance-none cursor-pointer"
                    style={{ background: '#161626', border: '1px solid #2a2a40' }}
                  >
                    {field.options?.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={field.type ?? 'text'}
                    placeholder={field.placeholder}
                    value={values[field.name] ?? ''}
                    onChange={e => setValues(v => ({ ...v, [field.name]: e.target.value }))}
                    className="w-full rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600"
                    style={{ background: '#161626', border: '1px solid #2a2a40' }}
                  />
                )}
                {field.hint && (
                  <p className="mt-1 text-xs text-slate-500">{field.hint}</p>
                )}
              </div>
            ))}
          </div>

          {/* Submit */}
          <div className="flex items-center gap-3 pt-1">
            <button
              type="submit"
              disabled={loading}
              className="px-5 py-2 rounded-lg text-sm font-semibold text-white transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                background: loading ? '#2a2a40' : `linear-gradient(135deg, ${style.accent}, ${style.accent}cc)`,
                boxShadow: loading ? 'none' : `0 0 12px ${style.glow}`,
              }}
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <span className="inline-block w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Processing...
                </span>
              ) : needsWallet && !connected ? 'Connect Wallet' : fn.submitLabel}
            </button>
          </div>

          {/* Result */}
          {result && (
            <div
              className="rounded-lg px-4 py-3 text-xs font-mono whitespace-pre-wrap leading-relaxed break-all"
              style={{
                background: result.type === 'error' ? '#1a0a0a' : result.type === 'success' ? '#0a1a0a' : '#0a0a1a',
                border: `1px solid ${result.type === 'error' ? '#7f1d1d' : result.type === 'success' ? '#14532d' : '#1e3a5f'}`,
                color: result.type === 'error' ? '#fca5a5' : result.type === 'success' ? '#86efac' : '#93c5fd',
              }}
            >
              {result.text}
            </div>
          )}
        </form>
      </div>
    </div>
  );
}

// ─── Section Block ────────────────────────────────────────────────────────────

function SectionBlock({
  id,
  label,
  icon,
  functions,
  network,
}: {
  id: SectionId;
  label: string;
  icon: string;
  functions: FunctionDef[];
  network: Network;
}) {
  const style = SECTION_STYLE[id];

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 mb-4">
        <span className="text-xl">{icon}</span>
        <h2 className="text-lg font-bold text-white tracking-wide">{label}</h2>
        <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${style.badge}`}>
          {functions.length} functions
        </span>
        <div className="flex-1 h-px" style={{ background: `linear-gradient(to right, ${style.accent}44, transparent)` }} />
      </div>

      <div className="space-y-2">
        {functions.map(fn => (
          <AccordionItem key={fn.id} fn={fn} section={id} network={network} />
        ))}
      </div>
    </div>
  );
}

// ─── Network Toggle ───────────────────────────────────────────────────────────

function NetworkToggle({ network, setNetwork }: { network: Network; setNetwork: (n: Network) => void }) {
  return (
    <div className="flex items-center gap-1 p-1 rounded-xl" style={{ background: '#0e0e1a', border: '1px solid #1e1e30' }}>
      <button
        onClick={() => setNetwork('devnet')}
        className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-all duration-150 ${
          network === 'devnet' ? 'text-white' : 'text-slate-500 hover:text-slate-300'
        }`}
        style={
          network === 'devnet'
            ? { background: 'linear-gradient(135deg, #7c3aed, #6d28d9)', boxShadow: '0 0 12px rgba(124,58,237,0.4)' }
            : {}
        }
      >
        Devnet
      </button>
      <button
        onClick={() => setNetwork('mainnet')}
        className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-all duration-150 ${
          network === 'mainnet' ? 'text-white' : 'text-slate-500 hover:text-slate-300'
        }`}
        style={
          network === 'mainnet'
            ? { background: 'linear-gradient(135deg, #dc2626, #b91c1c)', boxShadow: '0 0 12px rgba(220,38,38,0.4)' }
            : {}
        }
      >
        Mainnet
      </button>
    </div>
  );
}

// ─── Wallet Button ────────────────────────────────────────────────────────────

function WalletButton() {
  const { publicKey, connected, disconnect, wallet } = useWallet();
  const { setVisible } = useWalletModal();
  const [showMenu, setShowMenu] = useState(false);

  if (!connected || !publicKey) {
    return (
      <button
        onClick={() => setVisible(true)}
        className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white transition-all duration-150"
        style={{
          background: 'linear-gradient(135deg, #7c3aed, #06b6d4)',
          boxShadow: '0 0 16px rgba(124,58,237,0.35)',
        }}
      >
        <span>Connect Wallet</span>
      </button>
    );
  }

  const short = `${publicKey.toBase58().slice(0, 4)}...${publicKey.toBase58().slice(-4)}`;

  return (
    <div className="relative">
      <button
        onClick={() => setShowMenu(m => !m)}
        className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-semibold transition-all"
        style={{
          background: '#0e0e1a',
          border: '1px solid rgba(139,92,246,0.4)',
          color: '#a78bfa',
        }}
      >
        {wallet?.adapter.icon && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={wallet.adapter.icon} alt={wallet.adapter.name} className="w-4 h-4 rounded" />
        )}
        <span className="font-mono">{short}</span>
        <span className="text-slate-500 text-xs">&#8964;</span>
      </button>

      {showMenu && (
        <div
          className="absolute right-0 top-full mt-2 rounded-xl overflow-hidden z-50 min-w-[180px]"
          style={{ background: '#0e0e1a', border: '1px solid #1e1e30', boxShadow: '0 8px 32px rgba(0,0,0,0.6)' }}
        >
          <div className="px-3 py-2 border-b" style={{ borderColor: '#1e1e30' }}>
            <p className="text-xs text-slate-500">Connected via {wallet?.adapter.name}</p>
            <p className="text-xs font-mono text-slate-300 mt-0.5 truncate">{publicKey.toBase58()}</p>
          </div>
          <button
            onClick={() => { disconnect(); setShowMenu(false); }}
            className="w-full px-3 py-2.5 text-left text-sm text-red-400 hover:bg-red-900/20 transition-colors"
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Mainnet Banner ───────────────────────────────────────────────────────────

function MainnetBanner() {
  return (
    <div
      className="rounded-xl p-4 flex items-start gap-3"
      style={{ background: '#1a0a0a', border: '1px solid #7f1d1d' }}
    >
      <span className="text-2xl flex-shrink-0 mt-0.5">&#9888;</span>
      <div>
        <p className="font-semibold text-red-300 text-sm">Not Yet Deployed on Mainnet</p>
        <p className="text-red-400/80 text-xs mt-1 leading-relaxed">
          The CyreneAI Early Sale Vault contract is currently deployed on <strong>Devnet only</strong>.
          Mainnet deployment is planned for a future release. Please switch to Devnet to interact with the vault.
        </p>
      </div>
    </div>
  );
}

// ─── Tab Nav ──────────────────────────────────────────────────────────────────

const TABS: { id: SectionId; label: string; icon: string }[] = [
  { id: 'view',  label: 'View',  icon: '&#128269;' },
  { id: 'user',  label: 'User',  icon: '&#128100;' },
  { id: 'admin', label: 'Admin', icon: '&#128274;' },
];

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Home() {
  const [network, setNetwork] = useState<Network>('devnet');
  const [activeTab, setActiveTab] = useState<SectionId>('view');

  return (
    <div className="min-h-screen" style={{ background: '#07070f' }}>
      {/* Header */}
      <header
        className="sticky top-0 z-10 px-6 py-4"
        style={{
          background: 'rgba(7,7,15,0.85)',
          backdropFilter: 'blur(12px)',
          borderBottom: '1px solid #1e1e30',
        }}
      >
        <div className="max-w-4xl mx-auto flex items-center justify-between gap-4">
          {/* Logo + title */}
          <div className="flex items-center gap-3">
            <div
              className="w-9 h-9 rounded-lg flex items-center justify-center text-sm font-black text-white flex-shrink-0"
              style={{ background: 'linear-gradient(135deg, #7c3aed, #06b6d4)' }}
            >
              CY
            </div>
            <div>
              <h1 className="text-sm font-bold text-white leading-none">CyreneAI</h1>
              <p className="text-xs text-slate-400 leading-none mt-0.5">Early Sale Vault</p>
            </div>
          </div>

          {/* Right controls */}
          <div className="flex items-center gap-3">
            <NetworkToggle network={network} setNetwork={setNetwork} />
            <WalletButton />
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8 space-y-8">
        {/* Mainnet warning */}
        {network === 'mainnet' && <MainnetBanner />}

        {/* Network badge */}
        <div className="flex items-center gap-2">
          <span
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold"
            style={{
              background: network === 'devnet' ? 'rgba(124,58,237,0.15)' : 'rgba(220,38,38,0.15)',
              color: network === 'devnet' ? '#a78bfa' : '#f87171',
              border: `1px solid ${network === 'devnet' ? '#7c3aed44' : '#dc262644'}`,
            }}
          >
            <span
              className="w-1.5 h-1.5 rounded-full animate-pulse"
              style={{ background: network === 'devnet' ? '#7c3aed' : '#dc2626' }}
            />
            {network === 'devnet' ? 'Devnet' : 'Mainnet'}
          </span>
          <span className="text-xs text-slate-500">
            {network === 'devnet' ? 'Connected to Solana Devnet' : 'Contract not yet deployed on Mainnet'}
          </span>
        </div>

        {/* Tab navigation */}
        <div
          className="flex gap-1 p-1 rounded-xl"
          style={{ background: '#0e0e1a', border: '1px solid #1e1e30' }}
        >
          {TABS.map(tab => {
            const active = activeTab === tab.id;
            const s = SECTION_STYLE[tab.id];
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold transition-all duration-200"
                style={
                  active
                    ? { background: s.accent + '22', color: s.accent, border: `1px solid ${s.accent}44` }
                    : { color: '#64648a', border: '1px solid transparent' }
                }
              >
                <span dangerouslySetInnerHTML={{ __html: tab.icon }} />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Section content */}
        {network === 'mainnet' ? (
          <div className="text-center py-16 text-slate-500 text-sm space-y-2">
            <div className="text-4xl mb-4">&#128274;</div>
            <p className="font-semibold text-slate-400">Mainnet not available yet</p>
            <p>Switch to Devnet to interact with the vault.</p>
          </div>
        ) : (
          <div className="space-y-10">
            {activeTab === 'view' && (
              <SectionBlock
                id="view"
                label="View"
                icon="&#128269;"
                functions={VIEW_FUNCTIONS}
                network={network}
              />
            )}
            {activeTab === 'user' && (
              <SectionBlock
                id="user"
                label="End User Functions"
                icon="&#128100;"
                functions={USER_FUNCTIONS}
                network={network}
              />
            )}
            {activeTab === 'admin' && (
              <SectionBlock
                id="admin"
                label="Admin Functions"
                icon="&#128274;"
                functions={ADMIN_FUNCTIONS}
                network={network}
              />
            )}
          </div>
        )}

        {/* Footer */}
        <footer className="pt-8 border-t text-center text-xs text-slate-600" style={{ borderColor: '#1e1e30' }}>
          CyreneAI Early Sale Vault &mdash; Solana Devnet &mdash; v0.1.0
        </footer>
      </main>
    </div>
  );
}
