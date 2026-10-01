#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly EVM_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
readonly REPOSITORY_ROOT="$(cd -- "$EVM_ROOT/../.." && pwd)"
readonly OUTPUT_DIR="$REPOSITORY_ROOT/deployments/evm/conformance/abi"
readonly TEMP_DIR="$(mktemp -d)"

readonly -a ARTIFACTS=(
    "src/ProtocolConfig.sol:ProtocolConfig|ProtocolConfig.abi.json"
    "src/SolverRegistry.sol:SolverRegistry|SolverRegistry.abi.json"
    "src/ResourceRegistry.sol:ResourceRegistry|ResourceRegistry.abi.json"
    "src/CashCarrySeriesRegistry.sol:CashCarrySeriesRegistry|CashCarrySeriesRegistry.abi.json"
    "src/UniswapV3SpotPort.sol:UniswapV3SpotPort|UniswapV3SpotPort.abi.json"
    "src/FirmInventoryReservationBook.sol:FirmInventoryReservationBook|FirmInventoryReservationBook.abi.json"
    "src/DirectInventorySpotPort.sol:DirectInventorySpotPort|DirectInventorySpotPort.abi.json"
    "src/PackageVerifier.sol:PackageVerifier|PackageVerifier.abi.json"
    "src/PackageVerifier.sol:PackageVerifierValidation|PackageVerifierValidation.abi.json"
    "src/NaryxStrategyAccount.sol:NaryxStrategyAccount|NaryxStrategyAccount.abi.json"
    "src/NaryxStrategyAccountFactory.sol:NaryxStrategyAccountFactory|NaryxStrategyAccountFactory.abi.json"
    "src/conformance/NaryxTestPerpMarket.sol:NaryxTestPerpMarket|NaryxTestPerpMarket.abi.json"
    "src/PackageQuoteShard.sol:PackageQuoteShard|PackageQuoteShard.abi.json"
    "src/PackageQuoteShardRegistry.sol:PackageQuoteShardRegistry|PackageQuoteShardRegistry.abi.json"
    "src/AsyncBondedPackageCoordinator.sol:AsyncBondedPackageCoordinator|AsyncBondedPackageCoordinator.abi.json"
    "src/PerformanceBondVault.sol:PerformanceBondVault|PerformanceBondVault.abi.json"
    "src/PolicyRegistry.sol:PolicyRegistry|PolicyRegistry.abi.json"
    "src/GmxV2ArbitrumAdapter.sol:GmxV2ArbitrumAdapter|GmxV2ArbitrumAdapter.abi.json"
    "src/GmxV2IsolatedAccount.sol:GmxV2IsolatedAccount|GmxV2IsolatedAccount.abi.json"
    "src/GmxV2IsolatedAccountFactory.sol:GmxV2IsolatedAccountFactory|GmxV2IsolatedAccountFactory.abi.json"
    "src/GmxV2ExitController.sol:GmxV2ExitController|GmxV2ExitController.abi.json"
    "src/GmxV2OrderVerifier.sol:GmxV2OrderVerifier|GmxV2OrderVerifier.abi.json"
    "src/GmxV2ExitOrderVerifier.sol:GmxV2ExitOrderVerifier|GmxV2ExitOrderVerifier.abi.json"
    "src/interfaces/IGmxV2.sol:IGmxV2ExitOrderVerifier|IGmxV2ExitOrderVerifier.abi.json"
    "src/interfaces/IAsyncVenueAdapter.sol:IAsyncVenueAdapter|IAsyncVenueAdapter.abi.json"
    "src/interfaces/IExactSpotPort.sol:IExactSpotPort|IExactSpotPort.abi.json"
    "src/interfaces/ISpotFillRecorder.sol:ISpotFillRecorder|ISpotFillRecorder.abi.json"
    "src/interfaces/ISynFuturesInstrument.sol:ISynFuturesInstrument|ISynFuturesInstrument.abi.json"
    "src/interfaces/ISynFuturesPositionObserver.sol:ISynFuturesPositionObserver|ISynFuturesPositionObserver.abi.json"
    "src/interfaces/IPerpMarginGate.sol:IPerpMarginGate|IPerpMarginGate.abi.json"
)

trap 'rm -rf -- "$TEMP_DIR"' EXIT

if ! command -v forge >/dev/null 2>&1; then
    echo "forge is required to publish EVM conformance ABIs" >&2
    exit 1
fi

for artifact in "${ARTIFACTS[@]}"; do
    IFS='|' read -r contract output_name <<< "$artifact"
    forge inspect --root "$EVM_ROOT" --json "$contract" abi > "$TEMP_DIR/$output_name"
done

mkdir -p "$OUTPUT_DIR"
for artifact in "${ARTIFACTS[@]}"; do
    IFS='|' read -r _ output_name <<< "$artifact"
    install -m 0644 "$TEMP_DIR/$output_name" "$OUTPUT_DIR/$output_name"
done
