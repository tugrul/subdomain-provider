
const axios = require('axios');

const apiBaseUrl = process.env.CRYPTLEX_API_BASE_URL;
const accessToken = process.env.CRYPTLEX_API_ACCESS_TOKEN;

async function isValidLicenseId(licenseId) {

    const {data, status} = await axios.get(apiBaseUrl + '/v3/licenses/' + licenseId, {
        validateStatus: false,
        headers: {
            'Authorization': 'Bearer ' + accessToken
        }
    });

    if (status !== 200) {
        return false;
    }

    return !data.revoked && !data.suspended;
}

async function getLicenseIdByLicenseKey(licenseKey) {

    const {data} = await axios.get(apiBaseUrl + '/v3/licenses', {
        params: {
            key: licenseKey
        },
        headers: {
            'Authorization': 'Bearer ' + accessToken
        }
    });

    if (!data || data.length === 0 || !data[0].id) {
        throw new Error('license key is not exists');
    }

    return data[0].id;
}

exports.isValidLicenseId = isValidLicenseId;
exports.getLicenseIdByLicenseKey = getLicenseIdByLicenseKey;
