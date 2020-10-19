// Lookup stats for the lockups
// ============================
//
// # How to Use
//
// ```
// $ node scripts/lockups.js
// ```
//
// This produces some logs and prints CSV output at the end, which can be used for the further
// analysis and comparison.
//
// If you want to query some historical data, pass `NEAR_QUERY_AT_BLOCK_HEIGHT` environment
// variable, and make sure that you use the RPC node that has that block available (most of the
// NEAR nodes are not archival, so only persist historical data for roughtly 2.5 days).
//
// ```
// env NEAR_QUERY_AT_BLOCK_HEIGHT=19194634 NEAR_RPC_URL=https://rpc.mainnet.near.org node scripts/lockups.js
// ```
//
// NOTE: 19194634 is the last block before Phase 2 unlocked the transfers.

const BN = require("bn.js");
const nearAPI = require("near-api-js");

const { WampNearExplorerConnection, ExplorerApi } = require("../explorer-api");

const NEAR_QUERY_AT_BLOCK_HEIGHT = process.env.NEAR_QUERY_AT_BLOCK_HEIGHT;

const WAMP_NEAR_EXPLORER_URL =
  process.env.WAMP_NEAR_EXPLORER_URL ||
  "wss://near-explorer-wamp.onrender.com/ws";
const WAMP_NEAR_EXPLORER_TOPIC_PREFIX =
  process.env.WAMP_NEAR_EXPLORER_TOPIC_PREFIX ||
  "com.nearprotocol.mainnet.explorer";
const NEAR_RPC_URL = process.env.NEAR_RPC_URL || "https://rpc.mainnet.near.org";

const ONE_NEAR = new BN("1 000 000 000 000 000 000 000 000");

function readOption(reader, f) {
  let x = reader.read_u8();
  if (x == 1) {
    return f();
  }
  return null;
}

function decodeLockupState(lockupContractState) {
  let reader = new nearAPI.utils.serialize.BinaryReader(lockupContractState);
  let owner = reader.read_string();
  let lockupAmount = reader.read_u128().toString();
  let terminationWithdrawnTokens = reader.read_u128().toString();
  let lockupDuration = reader.read_u64().toString();
  let releaseDuration = readOption(reader, () => reader.read_u64().toString());
  let lockupTimestamp = readOption(reader, () => reader.read_u64().toString());
  let tiType = reader.read_u8();
  let transferInformation;
  if (tiType == 0) {
    transferInformation = {
      transfers_timestamp: reader.read_u64(),
    };
  } else {
    transferInformation = {
      transfer_poll_account_id: reader.read_string(),
    };
  }
  let vestingType = reader.read_u8();
  vestingInformation = null;
  if (vestingType == 1) {
    vestingInformation = {
      VestingHash: reader.read_array(() => reader.read_u8()),
    };
  } else if (vestingType == 2) {
    let vestingStart = reader.read_u64();
    let vestingCliff = reader.read_u64();
    let vestingEnd = reader.read_u64();
    vestingInformation = { vestingStart, vestingCliff, vestingEnd };
  } else if (vestingType == 3) {
    vestingInformation = "TODO";
  }
  return {
    owner,
    lockupAmount,
    terminationWithdrawnTokens,
    lockupDuration,
    releaseDuration,
    lockupTimestamp,
    transferInformation,
    vestingInformation,
  };
}

(async function () {
  console.log("Lockup analytics");
  const explorerConnection = new WampNearExplorerConnection(
    WAMP_NEAR_EXPLORER_URL
  );
  const explorerApi = new ExplorerApi(
    await explorerConnection.open(),
    WAMP_NEAR_EXPLORER_TOPIC_PREFIX
  );

  const nearRpc = new nearAPI.providers.JsonRpcProvider(NEAR_RPC_URL);

  // TODO: Provide an equivalent method in near-api-js, so we don't need to hack it around.
  nearRpc.callViewMethod = async function (
    contractId,
    methodName,
    args,
    options
  ) {
    args = args || {};
    const result = await this.sendJsonRpc("query", {
      request_type: "call_function",
      account_id: contractId,
      method_name: methodName,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      ...options,
    });
    if (result.logs && result.logs.length > 0) {
      console.log(contractId, result.logs);
    }
    return (
      result.result &&
      result.result.length > 0 &&
      JSON.parse(Buffer.from(result.result).toString())
    );
  };

  const lockupAccountIds = await explorerApi.getLockups();
  await explorerConnection.close();

  let queryAtBlockHeight = parseInt(NEAR_QUERY_AT_BLOCK_HEIGHT);
  if (!queryAtBlockHeight) {
    const finalBlock = await nearRpc.block({ finality: "final" });
    queryAtBlockHeight = finalBlock.header.height;
  }

  const lockupsInfo = await Promise.all(
    lockupAccountIds.map(async (lockupAccountId) => {
      for (;;) {
        try {
          const lockupStateResponse = await nearRpc.sendJsonRpc("query", {
            request_type: "view_state",
            account_id: lockupAccountId,
            prefix_base64: Buffer.from("STATE").toString("base64"),
            block_id: queryAtBlockHeight,
          });
          if (lockupStateResponse.values.length === 0) {
            console.log(`Skipping ${lockupAccountId} since it does not exist`);
            break;
          }
          const lockupState = decodeLockupState(
            Buffer.from(lockupStateResponse.values[0].value, "base64")
          );

          const lockupOwnerAccountId = lockupState.owner;

          const isUnlocked =
            lockupState.releaseDuration === "0" &&
            lockupState.lockupTimestamp &&
            parseInt(lockupState.lockupTimestamp.slice(0, -6)) < +new Date();

          const lockupBalance = new BN(
            await nearRpc.callViewMethod(
              lockupAccountId,
              "get_balance",
              {},
              { block_id: queryAtBlockHeight }
            )
          );

          const lockupOwnerAccountInfo = await nearRpc.sendJsonRpc("query", {
            request_type: "view_account",
            account_id: lockupOwnerAccountId,
            block_id: queryAtBlockHeight,
          });

          const lockupOwnerBalance = new BN(lockupOwnerAccountInfo.amount).add(
            new BN(lockupOwnerAccountInfo.locked)
          );

          return {
            lockupAccountId,
            lockupOwnerAccountId,
            isUnlocked,
            lockupBalance,
            lockupOwnerBalance,
          };
        } catch (e) {
          if (
            typeof e.message === "string" &&
            e.message.includes("doesn't exist")
          ) {
            console.log(`Skipping ${lockupAccountId} due to`, e);
            break;
          }
          console.log(`Retrying ${lockupAccountId} due to`, e);
          const timeout = new Promise((resolve) => setTimeout(resolve, 1000));
          await timeout;
        }
      }
    })
  );

  console.log(
    "lockup-account-id,lockup-owner-account-id,is-unlocked,lockup-balance-near,owner-balance-near"
  );
  for (const {
    lockupAccountId,
    lockupOwnerAccountId,
    isUnlocked,
    lockupBalance,
    lockupOwnerBalance,
  } of lockupsInfo.filter((it) => it)) {
    console.log(
      `${lockupAccountId},${lockupOwnerAccountId},${isUnlocked},${lockupBalance
        .div(ONE_NEAR)
        .toString()},${lockupOwnerBalance.div(ONE_NEAR).toString()}`
    );
  }
})().catch((error) => console.error(error));
