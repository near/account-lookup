const BN = require("bn.js");
const nearAPI = require("near-api-js");

const { WampNearExplorerConnection, ExplorerApi } = require("../explorer-api");

const WAMP_NEAR_EXPLORER_URL =
  process.env.WAMP_NEAR_EXPLORER_URL ||
  "wss://near-explorer-wamp.onrender.com/ws";
const WAMP_NEAR_EXPLORER_TOPIC_PREFIX =
  process.env.WAMP_NEAR_EXPLORER_TOPIC_PREFIX ||
  "com.nearprotocol.mainnet.explorer";
const NEAR_RPC_URL = process.env.NEAR_RPC_URL || "https://rpc.mainnet.near.org";

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

(async () => {
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
  nearRpc.callViewMethod = async function (contractName, methodName, args) {
    const account = new nearAPI.Account({ provider: this });
    return await account.viewFunction(contractName, methodName, args);
  };

  const lockupAccountIds = await explorerApi.getLockups();
  console.log(
    "lockup-account-id,lockup-owner-account-id,is-unlocked,lockup-balance,owner-balance"
  );
  for (const lockupAccountId of lockupAccountIds) {
    const lockupOwnerAccountId = await nearRpc.callViewMethod(
      lockupAccountId,
      "get_owner_account_id",
      {}
    );

    const lockupStateResponse = await nearRpc.sendJsonRpc("query", {
      request_type: "view_state",
      finality: "final",
      account_id: lockupAccountId,
      prefix_base64: "U1RBVEU=",
    });
    const lockupState = decodeLockupState(
      Buffer.from(lockupStateResponse.values[0].value, "base64")
    );
    //console.log(lockupState, +new Date());

    const isUnlocked =
      lockupState.releaseDuration === "0" &&
      lockupState.lockupTimestamp && parseInt(lockupState.lockupTimestamp.slice(0, -6)) < +new Date();

    const lockupBalance = new BN(
      await nearRpc.callViewMethod(lockupAccountId, "get_balance", {})
    );

    const lockupOwnerAccountInfo = await nearRpc.sendJsonRpc("query", {
      request_type: "view_account",
      finality: "final",
      account_id: lockupOwnerAccountId,
    });

    const lockupOwnerBalance = new BN(lockupOwnerAccountInfo.amount).add(
      new BN(lockupOwnerAccountInfo.locked)
    );
    console.log(
      `${lockupAccountId},${lockupOwnerAccountId},${isUnlocked},${lockupBalance.toString()},${lockupOwnerBalance.toString()}`
    );
  }
})().catch((error) => console.error(error));
