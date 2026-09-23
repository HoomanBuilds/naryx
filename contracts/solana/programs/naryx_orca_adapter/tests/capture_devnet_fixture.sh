#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 EMPTY_FIXTURE_DIRECTORY" >&2
  exit 2
fi

fixture_dir="$1"
if [ ! -d "$fixture_dir" ] || [ -n "$(find "$fixture_dir" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
  echo "fixture directory must exist and be empty" >&2
  exit 2
fi

rpc_url="https://api.devnet.solana.com"
expected_genesis="EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
program_id="whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"
programdata_id="CtXfPzz36dH5Ws4UYKZvrQ1Xqzn42ecDW6y8NKuiN8nD"
loader_id="BPFLoaderUpgradeab1e11111111111111111111111"
token_program_id="TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
expected_program_hash="5ba0ae1569444542b67322d0f333b289d738efead363c02436c7869cf33c2928"
expected_programdata_hash="7da9b16e1d520167c563f8af2443b4084d4c4101e690bfe7ac977274b311bf5f"
expected_elf_hash="219b75e84661e6011dd12f7dbfc9e06357c45751f7d4641fc8bddd3bf829d3c4"
whirlpool="B9G57dSEh9hmMLGkCgyfSpvzuir52pPppsRapfZwSZwc"
tick_array_0="BsomkG4EHvBr49gpth27FckZvr7wvmPYxXibKJtJsHNd"
tick_array_1="4h7gTPfCjVTqMpBth9SBnc63K91ycSt4iQkxYiCFRBTY"
vault_a="HHu5Gjyp9RJMYKPfJ3SizvLMGQXLRJJ8SYKLYwkGpvX9"
vault_b="BeY7NwznDroBP3m2KVugptGnoR2XPPK5zeVpQg7fPk8K"

genesis="$(solana genesis-hash --url "$rpc_url")"
if [ "$genesis" != "$expected_genesis" ]; then
  echo "unexpected Solana genesis hash: $genesis" >&2
  exit 1
fi

response="$(curl --fail --silent --show-error "$rpc_url" \
  -H 'content-type: application/json' \
  --data-binary "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getMultipleAccounts\",\"params\":[[\"$program_id\",\"$programdata_id\",\"$whirlpool\",\"$tick_array_0\",\"$tick_array_1\",\"$vault_a\",\"$vault_b\"],{\"encoding\":\"base64\",\"commitment\":\"finalized\"}]}" )"
context_slot="$(jq -er '.result.context.slot' <<< "$response")"
block_time="$(curl --fail --silent --show-error "$rpc_url" \
  -H 'content-type: application/json' \
  --data-binary "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getBlockTime\",\"params\":[$context_slot]}" \
  | jq -er '.result')"

for entry in "0:program.bin" "1:programdata.bin" "2:whirlpool.bin" "3:tick0.bin" "4:tick1.bin" "5:vault-a.bin" "6:vault-b.bin"; do
  index="${entry%%:*}"
  name="${entry#*:}"
  jq -er ".result.value[$index].data[0]" <<< "$response" | base64 --decode > "$fixture_dir/$name"
done

jq -e --arg owner "$loader_id" '.result.value[0].owner == $owner and .result.value[0].executable == true' <<< "$response" > /dev/null
jq -e --arg owner "$loader_id" '.result.value[1].owner == $owner and .result.value[1].executable == false' <<< "$response" > /dev/null
for index in 2 3 4; do
  jq -e --arg owner "$program_id" ".result.value[$index].owner == \$owner and .result.value[$index].executable == false" <<< "$response" > /dev/null
done
for index in 5 6; do
  jq -e --arg owner "$token_program_id" ".result.value[$index].owner == \$owner and .result.value[$index].executable == false" <<< "$response" > /dev/null
done

printf '%s  %s\n' "$expected_program_hash" "$fixture_dir/program.bin" | sha256sum --check
printf '%s  %s\n' "$expected_programdata_hash" "$fixture_dir/programdata.bin" | sha256sum --check
tail -c +46 "$fixture_dir/programdata.bin" > "$fixture_dir/orca-devnet.so"
printf '%s  %s\n' "$expected_elf_hash" "$fixture_dir/orca-devnet.so" | sha256sum --check

printf '%s\n' "$context_slot" > "$fixture_dir/context-slot"
printf '%s\n' "$block_time" > "$fixture_dir/unix-timestamp"
{
  printf 'genesis %s\n' "$genesis"
  printf 'context_slot %s\n' "$context_slot"
  printf 'unix_timestamp %s\n' "$block_time"
  printf 'program %s\n' "$program_id"
  printf 'programdata %s\n' "$programdata_id"
  printf 'whirlpool %s\n' "$whirlpool"
  printf 'tick_array_0 %s\n' "$tick_array_0"
  printf 'tick_array_1 %s\n' "$tick_array_1"
  printf 'vault_a %s\n' "$vault_a"
  printf 'vault_b %s\n' "$vault_b"
} > "$fixture_dir/provenance.txt"

mapfile -t rent_epochs < <(grep -o '"rentEpoch":[0-9]*' <<< "$response" | cut -d: -f2)
if [ "${#rent_epochs[@]}" -ne 7 ]; then
  echo "unexpected account metadata count" >&2
  exit 1
fi
for entry in \
  "0:program:$program_id:program.bin" \
  "1:programdata:$programdata_id:programdata.bin" \
  "2:whirlpool:$whirlpool:whirlpool.bin" \
  "3:tick_array_0:$tick_array_0:tick0.bin" \
  "4:tick_array_1:$tick_array_1:tick1.bin" \
  "5:vault_a:$vault_a:vault-a.bin" \
  "6:vault_b:$vault_b:vault-b.bin"; do
  IFS=: read -r index name address file <<< "$entry"
  owner="$(jq -r ".result.value[$index].owner" <<< "$response")"
  lamports="$(jq -r ".result.value[$index].lamports" <<< "$response")"
  executable="$(jq -r ".result.value[$index].executable" <<< "$response")"
  data_hash="$(sha256sum "$fixture_dir/$file" | cut -d' ' -f1)"
  printf '%s address=%s owner=%s lamports=%s executable=%s rentEpoch=%s data_sha256=%s context_slot=%s\n' \
    "$name" "$address" "$owner" "$lamports" "$executable" "${rent_epochs[$index]}" "$data_hash" "$context_slot"
done > "$fixture_dir/account-metadata.txt"

(
  cd "$fixture_dir"
  sha256sum orca-devnet.so program.bin programdata.bin whirlpool.bin tick0.bin tick1.bin vault-a.bin vault-b.bin > SHA256SUMS
  sha256sum --check SHA256SUMS
)
