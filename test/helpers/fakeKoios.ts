/**
 * A stand-in for Koios on 127.0.0.1, for tests that build real transactions without a chain.
 *
 * It serves what the `exact` signer reads: the protocol parameters (which the test chooses — that is
 * the point of it) and one wallet UTxO. Nothing is submitted anywhere. Anything else it is asked is a
 * 404, and `requests` says what was asked.
 */
import { createServer, type Server } from "node:http";

/** The preprod test token the policy examples use. */
export const TUSDM = "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d";

/** Mainnet's own parameters at epoch 661: what an honest provider answers. */
export const HONEST = { minFeeA: 44, coinsPerUtxoByte: 4310 };

export function protocolParameters(minFeeA: number, coinsPerUtxoByte: number) {
  const s = (n: number | string) => String(n);
  return [{
    pvt_motion_no_confidence: "0.51", pvt_committee_normal: "0.51", pvt_committee_no_confidence: "0.51",
    pvt_hard_fork_initiation: "0.51", pvtpp_security_group: "0.51", dvt_motion_no_confidence: "0.67",
    dvt_committee_normal: "0.67", dvt_committee_no_confidence: "0.6", dvt_update_to_constitution: "0.75",
    dvt_hard_fork_initiation: "0.6", dvt_p_p_network_group: "0.67", dvt_p_p_economic_group: "0.67",
    dvt_p_p_technical_group: "0.67", dvt_p_p_gov_group: "0.75", dvt_treasury_withdrawal: "0.67",
    committee_min_size: "7", committee_max_term_length: "146", gov_action_lifetime: "6",
    gov_action_deposit: "100000000000", drep_deposit: "500000000", drep_activity: "20",
    min_fee_ref_script_cost_per_byte: "15", epoch_no: "661", min_fee_a: s(minFeeA), min_fee_b: "155381",
    max_block_size: "90112", max_tx_size: "16384", max_bh_size: "1100", key_deposit: "2000000",
    pool_deposit: "500000000", max_epoch: "18", optimal_pool_count: "500", influence: "0.3",
    monetary_expand_rate: "0.003", treasury_growth_rate: "0.2", decentralisation: "0", extra_entropy: null,
    protocol_major: "10", protocol_minor: "0", min_utxo_value: "0", min_pool_cost: "170000000",
    nonce: null, block_hash: null, cost_models: { PlutusV1: [], PlutusV2: [], PlutusV3: [] },
    price_mem: "0.0577", price_step: "0.0000721", max_tx_ex_mem: "14000000", max_tx_ex_steps: "10000000000",
    max_block_ex_mem: "62000000", max_block_ex_steps: "20000000000", max_val_size: "5000",
    collateral_percent: "150", max_collateral_inputs: "3", coins_per_utxo_size: s(coinsPerUtxoByte),
  }];
}

export interface FakeKoios {
  /** `http://127.0.0.1:<port>`: a Koios `baseUrl`. */
  url: string;
  /** "METHOD /path" for everything it was asked. */
  requests: string[];
  /** What it answers from now on. */
  setParameters(p: { minFeeA: number; coinsPerUtxoByte: number }): void;
  /** Another UTxO for the wallet (a different one per number), so a second payment is not utxo_busy. */
  setUtxo(n: number): void;
  close(): Promise<void>;
}

export async function fakeKoios(initial: { minFeeA?: number; coinsPerUtxoByte?: number; lovelace?: string; tokenUnits?: string } = {}): Promise<FakeKoios> {
  const [policyId, assetName] = TUSDM.split(".");
  let params = { minFeeA: initial.minFeeA ?? HONEST.minFeeA, coinsPerUtxoByte: initial.coinsPerUtxoByte ?? HONEST.coinsPerUtxoByte };
  const lovelace = initial.lovelace ?? "1000000000";
  const tokenUnits = initial.tokenUnits ?? "10000000";
  let utxo = 1;
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", () => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      requests.push(`${req.method} ${path}`);
      res.setHeader("content-type", "application/json");
      if (path === "/epoch_params") return res.end(JSON.stringify(protocolParameters(params.minFeeA, params.coinsPerUtxoByte)));
      if (path === "/address_info") {
        const asked = (() => {
          try {
            return String((JSON.parse(body) as { _addresses?: string[] })._addresses?.[0] ?? "");
          } catch {
            return "";
          }
        })();
        return res.end(JSON.stringify([{
          address: asked, balance: lovelace, stake_address: null, script_address: false,
          utxo_set: [{
            tx_hash: utxo.toString(16).padStart(2, "0").repeat(32), tx_index: "0", block_time: "1792000000", block_height: "14000000",
            value: lovelace, datum_hash: null, inline_datum: null, reference_script: null,
            asset_list: [{ policy_id: policyId, asset_name: assetName, fingerprint: "asset1x", decimals: "6", quantity: tokenUnits }],
          }],
        }]));
      }
      res.statusCode = 404;
      res.end("[]");
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    setParameters: p => void (params = p),
    setUtxo: n => void (utxo = n),
    close: () => new Promise<void>(resolve => (server.closeAllConnections(), server.close(() => resolve()))),
  };
}
