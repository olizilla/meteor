/**
 * Send an OAuth login method to the server. If the user authorized
access in the popup this should log the user in, otherwise
nothing should happen.
 * @param  {String}   credentialToken
 * @param  {Function} callback
 */
Accounts.oauth.tryLoginAfterPopupClosed = function(credentialToken, callback) {
  var credentialSecret = OAuth._retrieveCredentialSecret(credentialToken) || null;
  Accounts.callLoginMethod({
    methodArguments: [{oauth: {
      credentialToken: credentialToken,
      credentialSecret: credentialSecret
    }}],
    userCallback: callback && function (err) {
      // Allow server to specify a specify subclass of errors. We should come
      // up with a more generic way to do this!
      if (err && err instanceof Meteor.Error &&
          err.error === Accounts.LoginCancelledError.numericError) {
        callback(new Accounts.LoginCancelledError(err.reason));
      } else {
        callback(err);
      }
    }});
};

/**
 * Call when the credential request is complete XXX no idea
 * @param  {Function} callback
 * @return {function} XXX Some kind of function
 */
Accounts.oauth.credentialRequestCompleteHandler = function(callback) {
  return function (credentialTokenOrError) {
    if(credentialTokenOrError && credentialTokenOrError instanceof Error) {
      callback && callback(credentialTokenOrError);
    } else {
      Accounts.oauth.tryLoginAfterPopupClosed(credentialTokenOrError, callback);
    }
  };
};
