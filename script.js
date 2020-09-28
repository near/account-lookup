import 'regenerator-runtime'

import * as nearAPI from 'near-api-js';
import sha256 from 'js-sha256';
import { encode, decode } from 'bs58';

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

async function lookup() {
    const inputAccountId = document.querySelector('#account').value;
    const near = await nearAPI.connect(options);
    const accountId = prepareAccountId(inputAccountId);
    console.log(accountId);
    try {
        let account = await near.account(accountId);
        let state = await account.state();
        document.querySelector('#account-id').textContent = `${accountId}, balance: ${nearAPI.utils.format.formatNearAmount(state.amount, 2)}`;

        try {
            let lockupAccountId = accountToLockup('lockup.near', accountId);
            console.log(lockupAccountId);
            let lockupAccount = await near.account(lockupAccountId);
            let lockupState = await lockupAccount.state();
            document.querySelector('#result').textContent = `Lockup ${lockupAccountId}, balance: ${nearAPI.utils.format.formatNearAmount(lockupState.amount, 2)}`;
        } catch (error) {
            console.log(error);
            document.querySelector('#result').textContent = `Lockup doesn't exist`;
        }
    } catch (error) {
        console.log(error);
        document.querySelector('#account-id').textContent = `${accountId} doesn't exist`;
    }
}

window.nearAPI = nearAPI;
window.lookup = lookup;