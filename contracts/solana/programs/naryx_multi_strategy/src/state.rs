use anchor_lang::prelude::*;
use naryx_core::{
    state::{DescriptorRef, FeePolicyDirection, ManifestRef, SettlementRef},
    wire::DomainRef,
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum StrategyOperation {
    Enter,
    Increase,
    Decrease,
    Rebalance,
    Roll,
    Migrate,
    Exit,
    EmergencyUnwind,
}

impl StrategyOperation {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Exit | Self::EmergencyUnwind)
    }

    pub fn requires_only_risk_reduction(self) -> bool {
        matches!(self, Self::Decrease | Self::Exit | Self::EmergencyUnwind)
    }

    pub fn requires_only_risk_increase(self) -> bool {
        matches!(self, Self::Enter | Self::Increase)
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct StrategyExecutionArgs {
    pub domain: DomainRef,
    pub package_id: [u8; 32],
    pub order_hash: [u8; 32],
    pub graph_hash: [u8; 32],
    pub quote_hash: [u8; 32],
    pub route_hash: [u8; 32],
    pub template: DescriptorRef,
    pub settlement: SettlementRef,
    pub operation: StrategyOperation,
    pub previous_state_hash: [u8; 32],
    pub next_state_hash: [u8; 32],
    pub total_gross_notional_atoms: u64,
    pub fees: StrategyFeeTerms,
    pub solver: Pubkey,
    pub nonce: u64,
    pub deadline_slot: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace, Debug)]
pub struct StrategyFeeTerms {
    pub direction: FeePolicyDirection,
    pub quote_asset: ManifestRef,
    pub policy_version: u32,
    pub policy_manifest_hash: [u8; 32],
    pub protocol_fee_atoms: u64,
    pub solver_fee_atoms: u64,
}

impl StrategyFeeTerms {
    pub fn is_zero(&self) -> bool {
        self.quote_asset.subject_id == [0u8; 32]
            && self.quote_asset.manifest_version == 0
            && self.quote_asset.manifest_hash == [0u8; 32]
            && self.policy_version == 0
            && self.policy_manifest_hash == [0u8; 32]
            && self.protocol_fee_atoms == 0
            && self.solver_fee_atoms == 0
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct StrategyCallArgs {
    pub adapter: ManifestRef,
    pub stage: u8,
    pub risk_increasing: bool,
    pub gross_notional_atoms: u64,
    pub account_count: u8,
    pub payload: Vec<u8>,
}

#[account]
#[derive(InitSpace)]
pub struct MultiStrategyAccount {
    pub version: u8,
    pub config: Pubkey,
    pub owner: Pubkey,
    pub next_nonce: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct StrategyPosition {
    pub version: u8,
    pub package_id: [u8; 32],
    pub domain: DomainRef,
    pub template: DescriptorRef,
    pub state_hash: [u8; 32],
    pub last_receipt_hash: [u8; 32],
    pub active: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct StrategyReceipt {
    pub version: u8,
    pub package_id: [u8; 32],
    pub order_hash: [u8; 32],
    pub graph_hash: [u8; 32],
    pub quote_hash: [u8; 32],
    pub route_hash: [u8; 32],
    pub operation: StrategyOperation,
    pub previous_state_hash: [u8; 32],
    pub next_state_hash: [u8; 32],
    pub calls_hash: [u8; 32],
    pub evidence_root: [u8; 32],
    pub receipt_hash: [u8; 32],
    pub fees: StrategyFeeTerms,
    pub nonce: u64,
    pub solver: Pubkey,
    pub execution_slot: u64,
    pub bump: u8,
}
