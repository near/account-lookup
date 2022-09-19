import "regenerator-runtime";

import * as nearAPI from "near-api-js";
import BN from "bn.js";
import sha256 from "js-sha256";
import { decode } from "bs58";
import Mustache from "mustache";
const DOES_NOT_EXIST = " doesn't exist";

function accountToLockup(masterAccountId, accountId) {
  return `${sha256(Buffer.from(accountId))
    .toString("hex")
    .slice(0, 40)}.${masterAccountId}`;
}

function prepareAccountId(data) {
  if (data.toLowerCase().endsWith(".near")) {
    return data
      .replace("@", "")
      .replace("https://wallet.near.org/send-money/", "")
      .toLowerCase();
  };
  if (data.length === 64 && !data.startsWith("ed25519:")) {
    return data;
  };
  let publicKey;
  if (data.startsWith("NEAR")) {
    publicKey = decode(data.slice(4)).slice(0, -4);
  } else {
    publicKey = decode(data.replace("ed25519:", ""));
  }
  return publicKey.toString("hex");
}

const readOption = (reader, f, defaultValue) => {
  let x = reader.read_u8();
  return x === 1 ? f() : defaultValue;
};

// query the NEAR Rpc to get the latest block height
async function getChainTip() {
  const statusUrl = "https://rpc.mainnet.near.org/status";
  const req = await fetch(statusUrl);
  const data = await req.json();
  return data.sync_info;
};

// get the block timestamp, to calculate the correct vesting information, and the epoch height
async function getBlockInfo(rpcProvider, height) {
  const res = {};
  // get the block data
  const blockData = await rpcProvider.connection.provider.sendJsonRpc("block",{ "block_id": height
  });
  res["block_height"] = await blockData.header.height;
  res["block_hash"] = await blockData.header.hash;
  res["block_timestamp"] = new Date(await blockData.header.timestamp/1000000);
  res["block_nanosec"] = await blockData.header.timestamp;
  // get the epoch data, aka the last block when rewards were distributed
  const epochBlockInfo = await rpcProvider.connection.provider.sendJsonRpc("block", {
    "block_id": blockData.header.next_epoch_id
  });
  res["epoch_height"] = await epochBlockInfo.header.height;
  res["epoch_hash"] = await epochBlockInfo.header.hash;
  res["epoch_timestamp"] = new Date(await epochBlockInfo.header.timestamp/1000000);
  res["epoch_nanosec"] = await epochBlockInfo.header.timestamp
  return res;
};

async function viewLockupState(connection, contractId) {
  const result = await connection.provider.sendJsonRpc("query", {
    "request_type": "view_state",
    "block_id": blockHeight,
    "account_id": contractId,
    "prefix_base64": "U1RBVEU="
    //, "finality": "final"
  });
  let value = Buffer.from(result.values[0].value, "base64");
  let reader = new nearAPI.utils.serialize.BinaryReader(value);
  let owner = reader.read_string();
  let lockupAmount = reader.read_u128().toString();
  let terminationWithdrawnTokens = reader.read_u128().toString();
  let lockupDuration = reader.read_u64().toString();
  let releaseDuration = readOption(
    reader,
    () => reader.read_u64().toString(),
    "0"
  );
  let lockupTimestamp = readOption(
    reader,
    () => reader.read_u64().toString(),
    "0"
  );
  let tiType = reader.read_u8();
  let transferInformation;
  if (tiType === 0) {
    transferInformation = {
      transfers_timestamp: reader.read_u64(),
    };
  } else {
    transferInformation = {
      transfer_poll_account_id: reader.read_string(),
    };
  }
  let vestingType = reader.read_u8();
  let vestingInformation;
  switch (vestingType) {
    case 1:
      vestingInformation = {
        vestingHash: reader.read_array(() => reader.read_u8()),
      };
      break;
    case 2:
      let start = reader.read_u64();
      let cliff = reader.read_u64();
      let end = reader.read_u64();
      vestingInformation = { start, cliff, end };
      break;
    case 3:
      let unvestedAmount = reader.read_u128();
      let terminationStatus = reader.read_u8();
      vestingInformation = { unvestedAmount, terminationStatus };
      break;
    default:
      vestingInformation = "TODO";
      break;
  }

  return {
    owner,
    lockupAmount: new BN(lockupAmount),
    terminationWithdrawnTokens: new BN(terminationWithdrawnTokens),
    lockupDuration: new BN(lockupDuration),
    releaseDuration: new BN(releaseDuration),
    lockupTimestamp: new BN(lockupTimestamp),
    transferInformation,
    vestingInformation,
  };
}

// Api key to query the Figment DataHub archival node 
const figmentDhKey = process.env['api_key']

// Connect to the archival RPC endpoint
const options = {
  // nodeUrl: "https://rpc.mainnet.near.org",
  nodeUrl: "https://near-mainnet--rpc--archive.datahub.figment.io/apikey/"+figmentDhKey,
  networkId: "mainnet",
  deps: {},
};

async function lookupLockup(near, accountId) {
  const lockupAccountId = accountToLockup("lockup.near", accountId);
  try {
    /* Old query method:
    const lockupAccount = await near.account(lockupAccountId);
    const lockupAccountBalance = await lockupAccount.viewFunction(
      lockupAccountId,
      "get_balance",
      {}
    );
    const lockupState = await viewLockupState(near.connection, lockupAccountId);
    */
    const lockupAccount = await near.connection.provider.sendJsonRpc("query", {
        "request_type": "call_function",
        "block_id": blockHeight,
        "account_id": lockupAccountId,
        "method_name": "get_balance",
        "args_base64": ""
        //, "finality": "final"
      });
    
    const lockupAccountBalance = new Buffer.from(lockupAccount.result).slice(1,-1).toString();

    const lockupCode = await near.connection.provider.sendJsonRpc("query", {
      "request_type": "view_code",
      "block_id": blockHeight,
      "account_id": lockupAccountId
      //, "finality": "final"
    });
    
    const lockupState = await viewLockupState(near.connection, lockupAccountId);
    
    // More details: https://github.com/near/core-contracts/pull/136
    lockupState.hasBrokenTimestamp = [
      "3kVY9qcVRoW3B5498SMX6R3rtSLiCdmBzKs7zcnzDJ7Q",
      "DiC9bKCqUHqoYqUXovAnqugiuntHWnM3cAc7KrgaHTu",
      ].includes(lockupCode.hash);
    
    /* to be used if the old query method is reinstated:
      ].includes((await lockupAccount.state()).code_hash);
    */
    return { lockupAccountId, lockupAccountBalance, lockupState };
  } catch (error) {
    console.log(error);
    return {
      lockupAccountId: `${lockupAccountId}${DOES_NOT_EXIST}`,
      lockupAmount: 0,
    };
  }
}

async function fetchPools(masterAccount) {
  const result = await masterAccount.connection.provider.sendJsonRpc(
    "validators",
    [null]
  );
  const pools = new Set();
  const stakes = new Map();
  result.current_validators.forEach((validator) => {
    pools.add(validator.account_id);
    stakes.set(validator.account_id, validator.stake);
  });
  result.next_validators.forEach((validator) =>
    pools.add(validator.account_id)
  );
  result.current_proposals.forEach((validator) =>
    pools.add(validator.account_id)
  );
  let poolsWithFee = [];
  let promises = [];
  pools.forEach((accountId) => {
    promises.push(
      (async () => {
        let stake = nearAPI.utils.format.formatNearAmount(
          stakes.get(accountId),
          2
        );
        let fee = await masterAccount.viewFunction(
          accountId,
          "get_reward_fee_fraction",
          {}
        );
        poolsWithFee.push({
          accountId,
          stake,
          fee: `${(fee.numerator * 100) / fee.denominator}%`,
        });
      })()
    );
  });
  await Promise.all(promises);
  return poolsWithFee;
}

// Obsolete function: not yet updated with the blockId query method, so the result will always return the latest block state - as it is default with nearApiJs
async function updateStaking(near, accountId, lookupAccountId) {
  const template = document.getElementById("pool-template").innerHTML;
  document.getElementById("loader").classList.add("active");
  document.getElementById("error").style.display = "none";
  try {
    let masterAccount = await near.account(accountId);
    let pools = await fetchPools(masterAccount);
    let result = [];
    for (let i = 0; i < pools.length; ++i) {
      let directBalance = await masterAccount.viewFunction(
        pools[i].accountId,
        "get_account_total_balance",
        { account_id: accountId }
      );
      let lockupBalance = "0";
      if (lookupAccountId && !lookupAccountId.includes(DOES_NOT_EXIST)) {
        lockupBalance = await masterAccount.viewFunction(
          pools[i].accountId,
          "get_account_total_balance",
          { account_id: lookupAccountId }
        );
      }
      if (directBalance !== "0" || lockupBalance !== "0") {
        result.push({
          accountId: pools[i].accountId,
          directBalance: nearAPI.utils.format.formatNearAmount(
            directBalance,
            2
          ),
          lockupBalance: nearAPI.utils.format.formatNearAmount(
            lockupBalance,
            2
          ),
        });
      }
      document.getElementById("loader").className = "";
      document.getElementById("pools").innerHTML = Mustache.render(template, {
        result,
        scannedNotDone: i < pools.length - 1,
        scanned: i,
        totalPools: pools.length,
      });
    }
  } catch (error) {
    console.log(error);
  }
}

function getStartLockupTimestamp(lockupState) {
  const phase2Time = new BN("1602614338293769340");
  let lockupTimestamp = BN.max(
    phase2Time.add(lockupState.lockupDuration),
    lockupState.lockupTimestamp
  );
  return lockupState.hasBrokenTimestamp ? phase2Time : lockupTimestamp;
}

const saturatingSub = (a, b) => {
  let res = a.sub(b);
  return res.gte(new BN(0)) ? res : new BN(0);
};

// https://github.com/near/core-contracts/blob/master/lockup/src/getters.rs#L64
async function getLockedTokenAmount(lockupState, blockHeightQuery) {
  const phase2Time = new BN("1602614338293769340");

  /* Previous lock calculation, which assumed "now" for the result:
  
  let now = new BN((new Date().getTime() * 1000000).toString());
  
  */
  let now = new BN(blockHeightQuery.toString());
  if (now.lte(phase2Time)) {
    return saturatingSub(
      lockupState.lockupAmount,
      lockupState.terminationWithdrawnTokens
    );
  }

  let lockupTimestamp = BN.max(
    phase2Time.add(lockupState.lockupDuration),
    lockupState.lockupTimestamp
  );
  let blockTimestamp = now;
  if (blockTimestamp.lt(lockupTimestamp)) {
    return saturatingSub(
      lockupState.lockupAmount,
      lockupState.terminationWithdrawnTokens
    );
  }

  let unreleasedAmount;
  if (lockupState.releaseDuration) {
    let startTimestamp = getStartLockupTimestamp(lockupState);
    let endTimestamp = startTimestamp.add(lockupState.releaseDuration);
    if (endTimestamp.lt(blockTimestamp)) {
      unreleasedAmount = new BN(0);
    } else {
      let timeLeft = endTimestamp.sub(blockTimestamp);
      unreleasedAmount = lockupState.lockupAmount
        .mul(timeLeft)
        .div(lockupState.releaseDuration);
    }
  } else {
    unreleasedAmount = new BN(0);
  }

  let unvestedAmount;
  if (lockupState.vestingInformation) {
    if (lockupState.vestingInformation.unvestedAmount) {
      // was terminated
      unvestedAmount = lockupState.vestingInformation.unvestedAmount;
    } else if (lockupState.vestingInformation.start) {
      // we have schedule
      if (blockTimestamp.lt(lockupState.vestingInformation.cliff)) {
        unvestedAmount = lockupState.lockupAmount;
      } else if (blockTimestamp.gte(lockupState.vestingInformation.end)) {
        unvestedAmount = new BN(0);
      } else {
        let timeLeft = lockupState.vestingInformation.end.sub(blockTimestamp);
        let totalTime = lockupState.vestingInformation.end.sub(
          lockupState.vestingInformation.start
        );
        unvestedAmount = lockupState.lockupAmount.mul(timeLeft).div(totalTime);
      }
    }
  }
  if (unvestedAmount === undefined) {
    unvestedAmount = new BN(0);
  }

  return BN.max(
    saturatingSub(unreleasedAmount, lockupState.terminationWithdrawnTokens),
    unvestedAmount
  );
}

function formatVestingInfo(info) {
  if (!info.hasOwnProperty("start")) return "TODO";
  const start = new Date(info.start.divn(1000000).toNumber());
  const cliff = new Date(info.cliff.divn(1000000).toNumber());
  const end = new Date(info.end.divn(1000000).toNumber());
  return `from ${start} until ${end} with cliff at ${cliff}`;
}

async function lookup() {
  blockHeight =  parseInt(document.getElementById("blockHeight").value);
  if (!(blockHeight)) {
    syncInfo = await getChainTip();
    // relaxed the blockHeight query to 10 blocks back from the tip, we are looking at an archive after all =)
    blockHeight = (await syncInfo.latest_block_height) -10;
    document.getElementById("blockHeight").value = blockHeight;
  };
  const inputAccountId = document.querySelector("#account").value;
  window.location.hash = inputAccountId;
  const near = await nearAPI.connect(options);

  let accountId = prepareAccountId(inputAccountId);

  let lockupAccountId = "",
    epochHeight = "",
    blockDate = "",
    lockupAccountBalance = 0,
    ownerAccountBalance = 0,
    lockupReleaseStartTimestamp = new BN(0),
    lockupState = null,
    lockedAmount = 0;
  const template = document.getElementById("template").innerHTML;
  document.getElementById("pools").innerHTML = "";
  try {
    // logs, just because
    console.log("trying "+accountId);
    console.log("at block height "+blockHeight);

    // cleaning up the output from previous queries and enabling the loader
    document.getElementById("output").innerHTML = '';
    document.getElementById("loader").classList.add("active");
    
    // retrieving the block and epoch information
    const blockInfo = await getBlockInfo(near, blockHeight);
    epochHeight = blockInfo.epoch_height.toString();
    blockDate = blockInfo.block_timestamp.toString();
    
    /* old query:
    
    let account = await near.account(accountId);
    let state = await account.state();
    
    */
    
    let state = await near.connection.provider.sendJsonRpc("query", {
      "request_type": "view_account",
      "block_id": blockHeight,
      "account_id": accountId
      //, "finality": "final"
    });
    ownerAccountBalance = state.amount;
    ({ lockupAccountId, lockupAccountBalance, lockupState } = await lookupLockup(near, accountId));
    
    if (lockupState) {
      lockupReleaseStartTimestamp = getStartLockupTimestamp(lockupState);
      lockedAmount = await getLockedTokenAmount(lockupState, blockInfo.block_nanosec);
      lockupState.releaseDuration = lockupState.releaseDuration
        .div(new BN("1000000000"))
        .divn(60)
        .divn(60)
        .divn(24)
        .toString(10);
      lockupState.vestingInformation = formatVestingInfo(
        lockupState.vestingInformation
      );
    }

    document.getElementById("loader").classList.remove("active");
    document.getElementById("output").innerHTML = Mustache.render(template, {
      epochHeight,
      blockDate,
      accountId,
      lockupAccountId,
      ownerAccountBalance: nearAPI.utils.format.formatNearAmount(
        ownerAccountBalance,
        2
      ),
      lockedAmount: nearAPI.utils.format.formatNearAmount(
        lockedAmount.toString(),
        2
      ),
      liquidAmount: nearAPI.utils.format.formatNearAmount(
        new BN(lockupAccountBalance).sub(new BN(lockedAmount)).toString(),
        2
      ),
      totalAmount: nearAPI.utils.format.formatNearAmount(
        new BN(ownerAccountBalance)
          .add(new BN(lockupAccountBalance))
          .toString(),
        2
      ),
      lockupReleaseStartDate: new Date(
        lockupReleaseStartTimestamp.divn(1000000).toNumber()
      ),
      lockupState,
    });
    /* disabled pool fetching to save resources, this is irrelevant for the sake of this tool:
    
    await updateStaking(near, accountId, lockupAccountId);
    
    */
  } catch (error) {
    document.getElementById("error").style.display = "block";
    document.getElementById("loader").classList.remove("active");
  }
};

window.nearAPI = nearAPI;
window.lookup = lookup;

window.onload = () => {
  (async() => {
    window.syncInfo = await getChainTip();
  })();
  
  if (window.location.hash) {
    document.querySelector("#account").value = window.location.hash.slice(1);
    lookup();
  }
};