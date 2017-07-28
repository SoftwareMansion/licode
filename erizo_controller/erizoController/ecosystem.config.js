/* global module */

module.exports = {
  apps: [
    {
      name: 'erizo-controller',
      script: 'erizoController.js',
      out_file: 'logs/out.log',
      error_file: 'logs/error.log',
      instance_var: 'NODE_APP_INSTANCE',
      instances: Number(process.env.ERIZO_CONTROLLER_INSTANCES),
    },
  ],
};
