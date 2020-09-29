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
        return { lockupAccountId, lockupAmount };
    } catch (error) {
        console.log(error);
        return { lockupAccountId: `${lockupAccountId} doesn't exist`, lockupAmount: 0 };
    }
}

async function checkVesting(account, lockupAccountId) {
    let result = await account.viewFunction(lockupAccountId, 'get_vesting_information', {});
    if (result != 'None') {
        if (result.VestingHash) {
            document.querySelector('#vesting').textContent = `Vesting hash: ${result.VestingHash}`;
        } else {
            document.querySelector('#vesting').textContent = `Vesting schedule: ${JSON.stringify(result.VestingSchedule)}`;
        }
    }
}

async function lookup() {
    const inputAccountId = document.querySelector('#account').value;
    const near = await nearAPI.connect(options);
    let accountId = prepareAccountId(inputAccountId);
    console.log(accountId);
    let lockupAccountId = '', lockupAmount = 0, totalAmount = 0, ownerAmount = 0;
    const template = document.getElementById('template').innerHTML;
    try {
        let account = await near.account(accountId);
        let state = await account.state();

        ownerAmount = state.amount;
        totalAmount = new BN(state.amount);

        ({ lockupAccountId, lockupAmount } = await lookupLockup(near, accountId));
        totalAmount = totalAmount.add(new BN(lockupAmount));
        await checkVesting(account, lockupAccountId);
    } catch (error) {
        console.log(error);
        accountId = `${accountId} doesn't exist`;
        ownerAmount = 0;
        totalAmount = 0;
        lockupAmount = 0;
    }
    console.log(ownerAmount, totalAmount, lockupAmount);
    document.getElementById('output').innerHTML = Mustache.render(template, { 
        accountId,
        lockupAccountId,
        ownerAmount: nearAPI.utils.format.formatNearAmount(ownerAmount, 2),
        totalAmount: nearAPI.utils.format.formatNearAmount(totalAmount.toString(), 2),
        lockupAmount: nearAPI.utils.format.formatNearAmount(lockupAmount, 2),
     });
}

window.nearAPI = nearAPI;
window.lookup = lookup;