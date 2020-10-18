const { getLockups } = require('../explorer-api');

(async () => {
    console.log("Lockup analytics");

    let lockups = await getLockups();
    console.log(lockups);
})().catch((error) => console.error(error));