import 'regenerator-runtime'

import * as nearAPI from 'near-api-js';
import BN from 'bn.js';
import sha256 from 'js-sha256';
import { encode, decode } from 'bs58';
import Mustache from 'mustache';

function accountToLockup(masterAccountId, accountId) {
    return `${sha256(Buffer.from(accountId)).toString('hex').slice(0, 40)}.${masterAccountId}`;
}

function prepareAccountId(data) {
    if (data.endsWith('.near')) {
        return data.replace('@', '').replace('https://wallet.near.org/send-money/', '');
    }
    if (data.length == 64 && !data.startsWith('ed25519:')) {
        return data;
    }
    let publicKey;
    if (data.startsWith('NEAR')) {
        publicKey = decode(data.slice(4)).slice(0, -4);
    } else {
        publicKey = decode(data.replace('ed25519:', ''));
    }
    return publicKey.toString('hex');
}

function readOption(reader, f) {
    let x = reader.read_u8();
    if (x == 1) {
        return f();
    }
    return null;
}

async function viewLockupState(connection, contractId) {
    const result = await connection.provider.sendJsonRpc("query", {
        request_type: "view_state",
        finality: "final",
        account_id: contractId,
        prefix_base64: "U1RBVEU=",
    });
    let value = Buffer.from(result.values[0].value, 'base64');
    let reader = new nearAPI.utils.serialize.BinaryReader(value);
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
            transfers_timestamp: reader.read_u64()
        };
    } else {
        transferInformation = {
            transfer_poll_account_id: reader.read_string()
        };
    };
    let vestingType = reader.read_u8();
    vestingInformation = null;
    if (vestingType == 1) {
        vestingInformation = { VestingHash: reader.read_array(() => reader.read_u8()) };
    } else if (vestingType == 2) {
        vestingInformation = 'TODO';
    } else if (vestingType == 3) {
        vestingInformation = 'TODO';
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
    }
}

const options = {
    nodeUrl: 'https://rpc.mainnet.near.org',
    networkId: 'mainnet',
    deps: { }
};

async function lookupLockup(near, accountId) {
    let lockupAccountId = accountToLockup('lockup.near', accountId);
    console.log(lockupAccountId);
    try {
        let lockupAccount = await near.account(accountId);
        let lockupAmount = await lockupAccount.viewFunction(lockupAccountId, 'get_balance', {});
        let lockupState = await viewLockupState(near.connection, lockupAccountId);
        return { lockupAccountId, lockupAmount, lockupState };
    } catch (error) {
        console.log(error);
        return { lockupAccountId: `${lockupAccountId} doesn't exist`, lockupAmount: 0 };
    }
}

async function lookup() {
    const inputAccountId = document.querySelector('#account').value;
    window.location.hash = inputAccountId;
    const near = await nearAPI.connect(options);
    let accountId = prepareAccountId(inputAccountId);
    console.log(accountId);
    let lockupAccountId = '', lockupAmount = 0, totalAmount = 0, ownerAmount = 0, lockupState = null;
    const template = document.getElementById('template').innerHTML;
    try {
        let account = await near.account(accountId);
        let state = await account.state();

        ownerAmount = state.amount;
        totalAmount = new BN(state.amount);

        ({ lockupAccountId, lockupAmount, lockupState } = await lookupLockup(near, accountId));
        if (lockupAmount !== 0) {
            lockupState.releaseDuration = parseInt(lockupState.releaseDuration) / 1000000000 / 60 / 60 / 24;
            if (lockupState.lockupTimestamp == null) {
                lockupState.lockupStart = "Phase 2";
            } else {
                lockupState.lockupStart = `${new Date(parseInt(lockupState.lockupTimestamp) / 1000000)} OR Phase 2, whichever comes later`;
            }
            if (lockupState.lockupDuration) {
                lockupState.lockupDuration = parseInt(lockupState.lockupDuration) / 1000000000 / 60 / 60 / 24;
            } else {
                lockupState.lockupDuration = null;
            }
            if (lockupState.vestingInformation) {
                lockupState.vestingInformation = Buffer.from(lockupState.vestingInformation.VestingHash).toString('base64');
            }
            totalAmount = totalAmount.add(new BN(lockupAmount));
            lockupState.lockupAmount = nearAPI.utils.format.formatNearAmount(lockupAmount.toString(), 2);
        }
    } catch (error) {
        console.log(error);
        accountId = `${accountId} doesn't exist`;
        ownerAmount = 0;
        totalAmount = 0;
        lockupAmount = 0;
    }
    console.log(lockupState);
    document.getElementById('output').innerHTML = Mustache.render(template, { 
        accountId,
        lockupAccountId,
        ownerAmount: nearAPI.utils.format.formatNearAmount(ownerAmount, 2),
        totalAmount: nearAPI.utils.format.formatNearAmount(totalAmount.toString(), 2),
        lockupState,
     });
}

window.nearAPI = nearAPI;
window.lookup = lookup;

window.onload = () => {
    if (window.location.hash) {
        document.querySelector('#account').value = window.location.hash.slice(1);
        lookup();
    }
};