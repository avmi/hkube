const Adapter = require('../Adapter');
const prometheus = require('../../helpers/prometheus');
const median = require('median');
const Cache = require('../../cache/cache-provider');

const PROM_SETTINGS = {
    HOURS: 500
};

class PrometheusAdapter extends Adapter {
    constructor(options, name) {
        super(options, name);
        this.mandatory = false;
        this._cache = new Cache({ key: this.name, maxAge: 1000 * 60 * 1 });
    }

    async getData() {
        const data = this._cache.get();
        if (data) {
            return data;
        }
        const resources = await this._getResources();
        const result = [];
        const algorithms = new Map();
        resources.cpuUsage.data.result.forEach(a => {
            const values = a.values.map(v => parseFloat(v[1]));
            algorithms.set(a.metric.label_algorithm_name, { cpuUsage: values });
        });
        resources.runTime.data.result.forEach(a => {
            const values = a.values.map(v => parseFloat(v[1]));
            const alg = algorithms.get(a.metric.algorithmName);
            algorithms.set(a.metric.algorithmName, { runTime: values, cpuUsage: alg && alg.cpuUsage });
        });
        algorithms.forEach((val, key) => {
            if (!val.runTime) {
                val.runTime = [0.0001];
            }
            if (!val.cpuUsage) {
                val.cpuUsage = [0.0001];
            }
            result.push({ algorithmName: key, runTime: median(val.runTime), cpuUsage: Math.max(...val.cpuUsage) });
        });
        this._cache.set(result);
        return result;
    }

    async _getResources() {
        const [cpuUsage, runTime] = await prometheus.range(PROM_SETTINGS.HOURS, [{
            query: `sum(
                    max(kube_pod_labels{label_algorithm_name!~""}) by (label_algorithm_name, pod)
                    * on(pod)
                    group_right(label_algorithm_name)
                    label_replace(
                        sum by(pod_name) (
                            rate(container_cpu_usage_seconds_total{container_name="algorunner"}[5m])
                        ), "pod", "$1", "pod_name", "(.+)")
                    ) by (label_algorithm_name)`
        },
        {
            query: 'algorithm_runtime_summary{quantile="0.5", algorithmName!~""}'
        }]);

        return { cpuUsage, runTime };
    }
}

module.exports = PrometheusAdapter;
