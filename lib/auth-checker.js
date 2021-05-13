
const { wrap } = require('@awaitjs/express');

function authChecker(callback = () => {}, optional = false) {
    return wrap(async (req, res, next) => {

        const {authorization} = req.headers;

        if (!authorization) {

            if (optional) {
                res.locals.authToken = null;
                return next();
            }

            res.status(401).json({success: false, message: 'authorization token is required'});
            return;
        }

        const token = /Bearer +([^\s]+)/.exec(authorization);

        if (!token) {
            res.status(400).json({success: false, message: 'invalid authorization token format'});
            return;
        }

        if (!await callback(token[1])) {
            res.status(401).json({success: false, message: 'authorization token is not valid'});
            return;
        }

        res.locals.authToken = token[1];
        next();
    });
}

module.exports = authChecker;