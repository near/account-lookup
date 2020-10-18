const autobahn = require("autobahn");

exports.WampNearExplorerConnection = class {
  constructor(wampNearExplorerUrl) {
    this.connection = new autobahn.Connection({
      realm: "near-explorer",
      transports: [
        {
          url: wampNearExplorerUrl,
          type: "websocket",
        },
      ],
      retry_if_unreachable: true,
      max_retries: Number.MAX_SAFE_INTEGER,
      max_retry_delay: 10,
    });
  }

  open() {
    return new Promise((resolve, reject) => {
      this.connection.onopen = (session) => resolve(session);
      this.connection.onclose = (reason) => reject(reason);
      this.connection.open();
    });
  }

  close() {
    this.connection._transport.onclose = () => {};
    this.connection.close();
  }
};

exports.ExplorerApi = class {
  constructor(wampNearExplorerSession, wampNearExplorerTopicPrefix) {
    this.wampNearExplorerSession = wampNearExplorerSession;
    this.wampNearExplorerTopicPrefix = wampNearExplorerTopicPrefix;
  }

  async call(handlerName, args, kwargs) {
    return await this.wampNearExplorerSession.call(
      `${this.wampNearExplorerTopicPrefix}.${handlerName}`,
      args,
      kwargs
    );
  }

  async getLockups(wampConnection) {
    const sql = `
        SELECT 
            DISTINCT receiver_id
        FROM 
            transactions
        WHERE
            receiver_id LIKE '%.lockup.near'
    `;

    /*
        LIMIT 
            :offset, :count
    const params = {
      offset: 0,
      count: 5,
    };
    */

    const uniqueLockupAccountIds = await this.call("select", [sql]);
    return uniqueLockupAccountIds.map((it) => it.receiver_id);
  }
};
