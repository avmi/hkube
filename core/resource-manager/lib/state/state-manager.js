const EventEmitter = require('events');
const Etcd = require('@hkube/etcd');

class StateManager extends EventEmitter {
    init({ serviceName, etcd }) {
        this._etcd = new Etcd();
        this._etcd.init({ etcd, serviceName });
        this._subscribe();
    }

    _subscribe() {
        this.watchStoreTemplates();
        this._etcd.algorithms.templatesStore.on('change', (res) => {
            this.emit(`templates-store`, res);
        });
    }

    getAlgorithmQueue(options) {
        return this._etcd.algorithms.algorithmQueue.list();
    }

    setQueueMetrics(options) {
        return this._etcd.algorithms.queueMetrics.setState(options);
    }

    setResourceRequirements(options) {
        return this._etcd.algorithms.resourceRequirements.setState(options);
    }

    getStoreTemplates(options) {
        return this._etcd.algorithms.templatesStore.list(options);
    }

    setStoreTemplates(options) {
        return this._etcd.algorithms.templatesStore.setState(options);
    }

    watchStoreTemplates(options) {
        return this._etcd.algorithms.templatesStore.watch(options);
    }
}

module.exports = new StateManager();