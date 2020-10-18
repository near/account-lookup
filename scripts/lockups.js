const { getLockups } = require('../explorer-api');

(async () => {
    console.log("Lockup analytics");

    lockups = await getLockups();
    console.log(lockups);
})().catch((error) => console.log(error));