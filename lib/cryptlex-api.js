
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

exports.isValidLicenseId = isValidLicenseId;
