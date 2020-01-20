const rp = require('request-promise');
const log = require('@hkube/logger').GetLogFromContainer();
const { boardStatuses } = require('@hkube/consts');
const etcd = require('../helpers/etcd');
const { createKindsSpec } = require('../deployments/tensorboard');
const kubernetes = require('../helpers/kubernetes');
const { normalizeBoardDeployments } = require('./normalize');
const deploymentType = require('../consts/DeploymentTypes').BOARD;
const _createBoardDeployment = async (deploymentDetails) => {
    const { versions, registry, clusterOptions, options, board } = deploymentDetails;
    const { boardReference, logDir } = board;
    const { deploymentSpec, serviceSpec, ingressSpec } = createKindsSpec({ boardReference, logDir, versions, registry, clusterOptions, options });
    await kubernetes.deployExposedPod({ deploymentSpec, ingressSpec, serviceSpec, name: boardReference }, deploymentType);
    board.status = boardStatuses.CREATING;
    board.timestamp = Date.now();
    await etcd.updateTensorboard(board);
};

const reconcile = async ({ boards, deployments, versions, registry, clusterOptions, options }) => {
    const normDeployments = normalizeBoardDeployments(deployments);
    const pending = boards.filter(b => b.status === boardStatuses.PENDING);
    const added = pending.filter(a => !normDeployments.find(d => d.boardReference === a.boardReference));
    const removed = normDeployments.filter(a => !boards.find(d => d.boardReference === a.boardReference));
    await Promise.all(added.map(a => _createBoardDeployment({ board: a, versions, registry, clusterOptions, options })));
    await Promise.all(removed.map(a => kubernetes.deleteExposedDeployment(a.boardReference, deploymentType)));
};

const updateTensorboards = async () => {
    const boards = await etcd.getTensorboards();
    const creating = boards.filter(b => b.status === boardStatuses.CREATING);
    await Promise.all(creating.map(async (board) => {
        const url = `http://board-service-${board.boardReference}.default.svc`;
        try {
            const result = await rp({ uri: url, resolveWithFullResponse: true });
            await etcd.updateTensorboard({ ...board, status: boardStatuses.RUNNING, timestamp: Date.now() });
            return { code: result.statusCode };
        }
        catch (error) {
            log.debug(`${url} ${error.message}`);
            return error.statusCode;
        }
    }));
};
module.exports = {
    reconcile, updateTensorboards
};
