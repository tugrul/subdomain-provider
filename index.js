
require('dotenv').config();

const redis = require('redis');
const express = require('express');
const DigitalOcean = require('do-wrapper').default;
const { wrap } = require('@awaitjs/express');
const { v4: uuidv4 } = require('uuid');
const {Validator: IpValidator} = require('ip-num/Validator');

const RedisPromise = require('./lib/redis-promise');
const authChecker = require('./lib/auth-checker');

const Redlock = require('redlock');

const router = express.Router()

const redisClient = new RedisPromise(redis.createClient());
const redlock = new Redlock([redisClient.originalClient]);
const doClient = new DigitalOcean(process.env.DO_API_TOKEN);



const clientAuthChecker = authChecker(
    async (token) => await redisClient.sismember('client_tokens', token)
);

const adminAuthChecker = authChecker(
    async (token) => process.env.ADMIN_TOKEN === token
);

async function getFreshToken(maxRetry = 10) {

    if (maxRetry === 0) {
        throw new Error('reached max retry count');
    }

    // generate new token
    const token = uuidv4();

    // retry to token generation if there is conflict
    if (await redisClient.sadd('client_tokens', token) === 0) {
        return getFreshToken(maxRetry - 1);
    }

    return token;
}

function isValidSubdomain(subdomain) {
    return /^[a-z0-9][a-z0-9\-]{0,49}$/i.test(subdomain);
}

async function isSubdomainAvailable(subdomain, authToken) {

    if (!isValidSubdomain(subdomain)) {
        throw new Error('invalid subdomain name');
    }

    if (await redisClient.sismember('banned_subdomains', subdomain)) {
        throw new Error('subdomain is banned, please use different subdomain name');
    }

    const subdomainOwner = await redisClient.hget('client_subdomains', subdomain);

    if (!subdomainOwner) {
        return true;
    }

    if (authToken && authToken !== subdomainOwner) {
        throw new Error('subdomain has a different owner');
    }

    return false;
}

async function updateSubdomainRecord(type, authToken, subdomain, address, prefix = '') {

    // allocate subdomain name for a client
    await redisClient.hset('client_subdomains', subdomain, authToken);
    await redisClient.hsetnx('client_subdomains_book_time', subdomain, Date.now());

    // do not create new dns subdomain records on simultaneous api requests for a client
    const resourceName = 'client_subdomain_' + type + '_id';
    // lock expire time is 30 seconds
    const lock = await redlock.lock(resourceName + ':' + authToken, 30000);

    const options = {
        type: type.toUpperCase(),
        name: prefix + subdomain,
        data: address,
        ttl: process.env.SUB_DOMAIN_TTL
    };

    console.log(options);

    const domainRecordId = await redisClient.hget(resourceName, authToken);

    if (domainRecordId) {
        console.log('update record');
        await doClient.domains.updateRecord(process.env.ROOT_DOMAIN, domainRecordId, options);
    } else {
        console.log('create record');
        const {domain_record: {id: domainRecordId}} = await doClient.domains.createRecord(process.env.ROOT_DOMAIN, options);
        await redisClient.hset(resourceName, authToken, domainRecordId);
    }

    await redisClient.hset('client_subdomain_' + type + '_address', subdomain, address);

    return lock.unlock();
}

async function updateRecordSubdomainName(type, subdomain, authToken) {
    const recordId = await redisClient.hget('client_subdomain_' + type + '_id', authToken);

    if (!recordId) {
        return;
    }

    const address = await redisClient.hget('client_subdomain_' + type + '_address', subdomain);

    if (!address) {
        return;
    }

    return doClient.domains.updateRecord(process.env.ROOT_DOMAIN, recordId, {
        type: type.toUpperCase(),
        name: subdomain,
        data: address,
        ttl: process.env.SUB_DOMAIN_TTL
    });
}

async function updateLatestSubdomainBook(type, authToken, subdomain) {

    const prevSubdomain = await redisClient.hget('client_subdomains_last', authToken);

    if (!prevSubdomain || prevSubdomain === subdomain) {
        return;
    }

    for (const target of ['a', 'aaaa']) {
        if (type !== target) {
            await updateRecordSubdomainName(target, subdomain, authToken);
        }
    }

    return redisClient.hset('client_subdomains_last', authToken, subdomain);
}

async function applySubdomainRecord(type, authToken, subdomain, data, prefix = '') {
    const lock = await redlock.lock('subdomain_record_attempt:' + subdomain, 50000);

    try {
        await isSubdomainAvailable(subdomain, authToken)
        await updateSubdomainRecord(type, authToken, subdomain, data, prefix);
        await updateLatestSubdomainBook(type, authToken, subdomain);
    } finally {
        await lock.unlock();
    }
}

async function cleanValidationData(authToken) {

    const recordId = await redisClient.hget('client_subdomain_txt_id', authToken);

    if (!recordId) {
        throw new Error('validation data is not exists');
    }

    await doClient.domains.deleteRecord(process.env.ROOT_DOMAIN, recordId);
    await redisClient.hdel('client_subdomain_txt_id', authToken);
}

const app = express();
const port = 3000;

app.use(express.json())
app.use('/subdomain-provider', router);

router.post('/check-subdomain-availability', wrap(async (req, res) => {

    const {subdomain} = req.body;

    if (!subdomain) {
        res.json({success: false, message: 'subdomain is not provided'});
        return;
    }

    try {
        const status = await isSubdomainAvailable(subdomain);
        res.json({success: true, available: status});
    } catch (err) {
        res.json({success: false, message: err.message});
    }

}));

router.get('/generate-token', adminAuthChecker, wrap(async (req, res) => {

    res.json({
        token: await getFreshToken()
    });

}));

router.post('/ban-subdomain', adminAuthChecker, wrap(async(req, res) => {

    const {subdomain} = req.body;

    if (!subdomain) {
        res.json({success: false, message: 'subdomain is not provided'});
        return;
    }


    if (!isValidSubdomain(subdomain)) {
        res.json({success: false, message: 'invalid subdomain'});
        return;
    }

    await redisClient.sadd('banned_subdomains', subdomain);

    res.json({success: true});

}));

router.post('/assign-ip-address', clientAuthChecker, wrap( async (req, res) => {

    const {authToken} = res.locals;
    const {ip_address, subdomain, type = 4} = req.body;

    if (!ip_address) {
        res.json({success: false, message: 'ip address is not provided'});
        return;
    }

    if (!subdomain) {
        res.json({success: false, message: 'subdomain is not provided'});
        return;
    }

    if (type === 4) {
        const [isValidIpAddress, validationMessage] = IpValidator.isValidIPv4String(ip_address);
        if (!isValidIpAddress) {
            res.json({success: false, message: 'invalid ipv4 address. ' + validationMessage});
            return;
        }

        try {
            await applySubdomainRecord('a', authToken, subdomain, ip_address);

        } catch (err) {
            res.json({success: false, message: err.message});
            return;
        }

        res.json({success: true});
        return;
    }

    if (type === 6) {
        const [isValidIpAddress, validationMessage] = IpValidator.isValidIPv6String(ip_address);
        if (!isValidIpAddress) {
            res.json({success: false, message: 'invalid ipv6 address. ' + validationMessage});
            return;
        }

        try {
            await applySubdomainRecord('aaaa', authToken, subdomain, ip_address);
        } catch (err) {
            res.json({success: false, message: err.message});
            return;
        }

        res.json({success: true});
        return;
    }

    res.json({success: false, message: 'valid ip types are 4 or 6', foo: res.locals.authToken});
}));

router.post('/assign-validation-data', clientAuthChecker, wrap(async (req, res) => {

    const {authToken} = res.locals;
    const {subdomain, data} = req.body;

    if (!subdomain) {
        res.json({success: false, message: 'subdomain is not provided'});
        return;
    }

    if (!data) {
        res.json({success: false, message: 'data is not provided'});
        return;
    }

    try {
        await applySubdomainRecord('txt', authToken, subdomain, data, '_acme-challenge.');
    } catch (err) {
        res.json({success: false, message: err.message});
        return;
    }

    res.json({success: true});

}));

router.delete('/clean-validation-data', clientAuthChecker, wrap(async (req, res) => {

    const {authToken} = res.locals;

    try {
        await cleanValidationData(authToken);
    } catch (err) {
        res.json({success: false, message: err.message});
        return;
    }

    res.json({success: true});

}));

app.listen(port, () => {
    console.log(`app listening at http://localhost:${port}`);
});