const orderBy = require('lodash.orderby');
const Adapter = require('../../../lib/adapters/Adapter');
const algorithmQueue = require('../data/algorithm-queue.json');

class AlgorithmQueueAdapter extends Adapter {

    constructor(settings, options) {
        super(settings);
    }

    async getData() {
        let mergedQueue = [];
        algorithmQueue.forEach(q => {
            mergedQueue = mergedQueue.concat(q.data);
        });
        mergedQueue = mergedQueue.map(q => ({ alg: q.algorithmName, batch: q.batchPlace, score: q.calculated.score * 10 }));
        mergedQueue = orderBy(mergedQueue, q => q.score, 'desc');
        return mergedQueue;
    }
}

module.exports = AlgorithmQueueAdapter;