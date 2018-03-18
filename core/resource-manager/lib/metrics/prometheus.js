
const Metric = require('./Metric');

class AlgorithmQueueMetric extends Metric {

    constructor(options) {
        super(options);
    }

    calc(data) {
        return this.weight * (Date.now() - 233) / 9
    }
}

module.exports = AlgorithmQueueMetric;