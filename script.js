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
    if (data.toLowerCase().endsWith('.near')) {
        return data.replace('@', '').replace('https://wallet.near.org/send-money/', '').toLowerCase();
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
    switch (vestingType) {
        case 1:
            vestingInformation = { VestingHash: reader.read_array(() => reader.read_u8()) };
            break;
        case 2:
            let vestingStart = reader.read_u64();
            let vestingCliff = reader.read_u64();
            let vestingEnd = reader.read_u64();
            vestingInformation = { vestingStart, vestingCliff, vestingEnd };
            break;
        case 3:
        default:
            vestingInformation = 'TODO';
            break;
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
        return { lockupAccountId, lockupAmount, lockupState: { ...lockupState } };
    } catch (error) {
        console.error(error);
        return { lockupAccountId: `${lockupAccountId} doesn't exist`, lockupAmount: 0 };
    }
}


async function fetchPools(masterAccount) {
    const result = await masterAccount.connection.provider.sendJsonRpc('validators', [null]);
    const pools = new Set();
    const stakes = new Map();
    result.current_validators.forEach((validator) => {
        pools.add(validator.account_id);
        stakes.set(validator.account_id, validator.stake);
    });
    result.next_validators.forEach((validator) => pools.add(validator.account_id));
    result.current_proposals.forEach((validator) => pools.add(validator.account_id));
    let poolsWithFee = [];
    let promises = []
    pools.forEach((accountId) => {
        promises.push((async () => {
            let stake = nearAPI.utils.format.formatNearAmount(stakes.get(accountId), 2);
            let fee = await masterAccount.viewFunction(accountId, 'get_reward_fee_fraction', {});
            poolsWithFee.push({ accountId, stake, fee: `${(fee.numerator * 100 / fee.denominator)}%` });
        })());
    });
    await Promise.all(promises);
    return poolsWithFee;
}

async function updateStaking(near, accountId, lookupAccountId) {
    const template = document.getElementById('pool-template').innerHTML;
    try {
        let masterAccount = await near.account(accountId);
        let pools = await fetchPools(masterAccount);
        let result = [];
        for (let i = 0; i < pools.length; ++i) {
            let directBalance = await masterAccount.viewFunction(pools[i].accountId, "get_account_total_balance", { account_id: accountId });
            let lockupBalance = "0";
            if (lookupAccountId) {
                lockupBalance = await masterAccount.viewFunction(pools[i].accountId, "get_account_total_balance", { account_id: lookupAccountId });
            }
            if (directBalance != "0" || lockupBalance != "0") {
                result.push({
                    accountId: pools[i].accountId,
                    directBalance: nearAPI.utils.format.formatNearAmount(directBalance, 2),
                    lockupBalance: nearAPI.utils.format.formatNearAmount(lockupBalance, 2),
                });
            }
            document.getElementById('pools').innerHTML = Mustache.render(template, {
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

async function lookup() {
    const inputAccountId = document.querySelector('#account').value;
    window.location.hash = inputAccountId;
    const near = await nearAPI.connect(options);
    let accountId = prepareAccountId(inputAccountId);
    console.log(accountId);
    let lockupAccountId = '', lockupAmount = 0, totalAmount = 0, ownerAmount = 0, lockupState = null, unlockedAmount = 0, lockedAmount = 0;
    const template = document.getElementById('template').innerHTML;
    document.getElementById('pools').innerHTML = '';
    phase2Time = 1602614338293769340;
    let phase2 = new Date(phase2Time / 1000000);
    try {
        let account = await near.account(accountId);
        let state = await account.state();

        ownerAmount = state.amount;
        totalAmount = new BN(state.amount);

        ({ lockupAccountId, lockupAmount, lockupState } = await lookupLockup(near, accountId));

        if (lockupAmount !== 0) {
            const lockupTimestamp = BN.max(
                new BN(phase2Time.toString()).add(new BN(lockupState.lockupDuration)),
                new BN(lockupState.lockupTimestamp ? lockupState.lockupTimestamp : 0),
            );
            let duration = lockupState.releaseDuration ? new BN(lockupState.releaseDuration) : new BN(0);
            let now = new Date().getTime() * 1000000;

            const endTimestamp = new BN(phase2Time.toString()).add(duration);
            const timeLeft = endTimestamp.sub(new BN(now.toString()));
            const releaseComplete = timeLeft.lte(new BN(0));

            console.log(timeLeft.toString(10), lockupState.releaseDuration, releaseComplete);

            lockupState.releaseDuration = lockupState.releaseDuration ? duration.div(
                new BN("1000000000")
              )
                .div(new BN("60"))
                .div(new BN("60"))
                .div(new BN("24"))
                .toString(10)
              : null;

            lockupState.lockupStart = phase2;

            if (lockupState.lockupTimestamp !== null) {
                let lockupTimestamp = new Date(parseInt(lockupState.lockupTimestamp) / 1000000);
                if (phase2 < lockupState.lockupTimestamp) {
                    lockupState.lockupStart = lockupTimestamp;
                }
            }

            if (lockupState.lockupDuration) {
                lockupState.lockupDuration = parseInt(lockupState.lockupDuration) / 1000000000 / 60 / 60 / 24;
            } else {
                lockupState.lockupDuration = null;
            }

            if (lockupState.vestingInformation) {
                if (lockupState.vestingInformation.VestingHash) {
                    lockupState.vestingInformation = `Hash: ${Buffer.from(lockupState.vestingInformation.VestingHash).toString('base64')}`;
                } else if (lockupState.vestingInformation.vestingStart) {
                    let vestingStart = new Date(parseInt(lockupState.vestingInformation.vestingStart.div(new BN("1000000"))));
                    if (vestingStart > phase2) {
                        let vestingCliff = new Date(parseInt(lockupState.vestingInformation.vestingCliff.div(new BN("1000000"))));
                        let vestingEnd = new Date(parseInt(lockupState.vestingInformation.vestingEnd.div(new BN("1000000"))));
                        lockupState.vestingInformation = `from ${vestingStart} until ${vestingEnd} with cliff at ${vestingCliff}`;
                    } else {
                        lockupState.vestingInformation = null;
                    }
                }
            }

            totalAmount = totalAmount.add(new BN(lockupAmount.toString()));

            lockupState.lockupAmount = nearAPI.utils.format.formatNearAmount(lockupAmount.toString(), 2);
            if (lockupTimestamp.lte(new BN(now.toString()))) {
                if (releaseComplete) {
                    unlockedAmount = lockupAmount;
                    lockedAmount = '0';
                } else {
                    if (lockupState.releaseDuration) {
                        lockedAmount = (new BN(lockupAmount)
                          .mul(timeLeft)
                          .div(duration)
                        );
                        unlockedAmount = (new BN(lockupAmount).sub(lockedAmount)).toString(10);
                    } else {
                        unlockedAmount = '0';
                        lockedAmount = lockupAmount;
                    }
                }
            } else {
                lockedAmount = lockupAmount;
                unlockedAmount = '0';
            }

            if (!lockupState.releaseDuration) {
                lockupState.releaseDuration = "0";
            }
        }
    } catch (error) {
        console.error(error);
        if (accountId.length < 64) {
            accountId = `${accountId} doesn't exist`;
        }
        ownerAmount = 0;
        totalAmount = 0;
        lockupAmount = 0;
        unlockedAmount = 0;
    }
    console.log(lockupState);
    document.getElementById('output').innerHTML = Mustache.render(template, {
        accountId,
        lockupAccountId,
        ownerAmount: nearAPI.utils.format.formatNearAmount(ownerAmount, 2),
        totalAmount: nearAPI.utils.format.formatNearAmount(totalAmount.toString(), 2),
        lockedAmount: nearAPI.utils.format.formatNearAmount(lockedAmount.toString(), 2),
        unlockedAmount: nearAPI.utils.format.formatNearAmount(unlockedAmount.toString(), 2),
        lockupState,
     });

    await updateStaking(near, accountId, lockupAccountId);
}

window.nearAPI = nearAPI;
window.lookup = lookup;

window.onload = () => {
    if (window.location.hash) {
        document.querySelector('#account').value = window.location.hash.slice(1);
        lookup();
    }
};
