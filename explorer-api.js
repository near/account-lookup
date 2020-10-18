const { Wampy } = require('wampy');

const WAMP_NEAR_EXPLORER_URL = process.env.WAMP_NEAR_EXPLORER_URL || 'wss://near-explorer-wamp.onrender.com/ws'
const WAMP_NEAR_EXPLORER_TOPIC_PREFIX = process.env.WAMP_NEAR_EXPLORER_TOPIC_PREFIX || 'com.nearprotocol.testnet.explorer'

const wamp = new Wampy(WAMP_NEAR_EXPLORER_URL, { realm: 'near-explorer' })

const queryExplorer = (sql, params) => new Promise((resolve, reject) => wamp.call(
    `${WAMP_NEAR_EXPLORER_TOPIC_PREFIX}.select`,
    [sql, params],
    {
        onSuccess(dataArr) {
            resolve(dataArr[0]);
        },
        onError(...args) {
            console.log(args)
            reject(args);
        }
    }
));

async function getLockups() {
    const sql = `
        SELECT 
            DISTINCT receiver_id
        FROM 
            transactions
        WHERE
            receiver_id LIKE '%.lockup.near'
        LIMIT 
            :offset, :count
    `

    const params = {
        offset: 0,
        count: 5
    }

    const tx = await queryExplorer(sql, params)

    return tx;
}

module.exports = {
    getLockups,
};