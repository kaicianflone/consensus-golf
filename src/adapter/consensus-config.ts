import type { ConsensusConfig } from '../schema/config.js'

// Build the full ConsensusToolsConfig from our simplified ConsensusConfig.
// We only use the local board (no global/remote mode).
export function buildConsensusToolsConfig(config: ConsensusConfig) {
  return {
    mode: 'local' as const,
    local: {
      storage: {
        kind: 'json' as const,
        path: config.storagePath,
      },
      server: {
        enabled: false,
        host: 'localhost',
        port: 9888,
        authToken: '',
      },
      slashingEnabled: true,
      jobDefaults: {
        reward: 10,
        stakeRequired: config.stakeRequired,
        maxParticipants: config.agents.length,
        minParticipants: 1,
        expiresSeconds: config.jobExpiresSeconds,
        consensusPolicy: {
          type: config.policy.type,
          quorum: config.policy.quorum,
          minScore: config.policy.minScore,
          minMargin: config.policy.minMargin,
          tieBreak: config.policy.tieBreak,
          approvalVote: {
            weightMode: config.policy.weightMode,
          },
        },
        slashingPolicy: { enabled: false, slashPercent: 0, slashFlat: 0 },
      },
      ledger: {
        faucetEnabled: true,
        initialCreditsPerAgent: config.initialCredits,
        balances: Object.fromEntries(config.agents.map((a) => [a, config.initialCredits])),
        balancesMode: 'initial' as const,
      },
    },
    global: { baseUrl: '', accessToken: '' },
    agentIdentity: {
      agentIdSource: 'manual' as const,
      manualAgentId: 'orchestrator',
    },
    safety: {
      requireOptionalToolsOptIn: false,
      allowNetworkSideEffects: false,
    },
  }
}
