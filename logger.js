
const {createLogger, format, transports} = require('winston');

const {NODE_ENV, LOGS_DIR} = process.env;

function getLogPath(fileName) {
    if (LOGS_DIR.length === 0) {
        return fileName;
    }

    return LOGS_DIR + (/\/$/.test(LOGS_DIR) ? '' : '/') + fileName;
}

const logger = createLogger({
    level: 'info',
    format: format.json(),
    defaultMeta: {service: 'subdomain-provider-api'},
    transports: [
        new transports.File({filename: getLogPath('error.log'), level: 'error'}),
        new transports.File({filename: getLogPath('combined.log')})
    ]
});

if (NODE_ENV !== 'production') {
    logger.add(new transports.Console({
        format: format.simple()
    }))
}

module.exports = logger
