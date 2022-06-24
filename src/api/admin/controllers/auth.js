/* Code copied/modified of 'callback' function, in node_modules/@strapi/plugin-users-permissions/server/controllers/auth.js
 *
 * Reference for this: https://gist.github.com/bibekgupta3333/7c4d4ec259045d7089c36b5ae0c4e763#file-strapi_v4_user_register_override-js
 *
 * Modified to also return the role of user who logged in
 */
'use strict';

const _ = require('lodash');
const jwt = require('jsonwebtoken');
const utils = require('@strapi/utils');

const { sanitize } = utils;
const { ApplicationError, ValidationError } = utils.errors;

const emailRegExp =
  /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;

async function sanitizeUser(user, ctx) {
  // NOTE: @adig Returning role too, with the user
  const { role } = user;
  const { auth } = ctx.state;
  const userSchema = strapi.getModel('plugin::users-permissions.user');

  return { role, ...(await sanitize.contentAPI.output(user, userSchema, { auth })) };
};

// validation
const { yup, validateYupSchema } = require('@strapi/utils');
const registerBodySchema = yup.object().shape({
  email: yup.string().email().required(),
  password: yup.string().required(),
});

const validateRegisterBody = validateYupSchema(registerBodySchema);

// JWT issuer
function issueJWT(payload, jwtOptions = {}) {
  _.defaults(jwtOptions, strapi.config.get('plugin.users-permissions.jwt'));
  return jwt.sign(
    _.clone(payload.toJSON ? payload.toJSON() : payload),
    strapi.config.get('plugin.users-permissions.jwtSecret'),
    jwtOptions
  );
};

module.exports = {
  //   Register controller override
  register_with_role: async (ctx) => {
    const pluginStore = strapi.store({
      type: 'plugin',
      name: 'users-permissions',
    });

    const settings = await pluginStore.get({
      key: 'advanced',
    });

    if (!settings.allow_register) {
      throw new ApplicationError('Register action is currently disabled');
    }

    const params = {
      ..._.omit(ctx.request.body, [
        'confirmed',
        'confirmationToken',
        'resetPasswordToken',
      ]),
      provider: 'local',
    };

    await validateRegisterBody(params);

    // Throw an error if the password selected by the user
    // contains more than three times the symbol '$'.
    if (
      strapi.service('plugin::users-permissions.user').isHashed(params.password)
    ) {
      throw new ValidationError(
        'Your password cannot contain more than three times the symbol `$`'
      );
    }

    /** NOTE: @adig: possible value for `role` are "student", "coordinator" */
    const role = params.role;

    if (!role) {
      throw new ValidationError('Please provide a role');
    }

    if (role == "admin") {
      throw new ValidationError("Admin cannot create another admin user !");
    }

    const role_entry = await strapi
      .query('plugin::users-permissions.role')
      .findOne({ where: { type: role }, select: ["id"] });

    if (!role_entry) {
      /** role is not "student" nor "coordinator", ie. the role doesn't exist in user-permissions collection */
      throw new ValidationError("Please provide a valid role");
    }

    const role_id = role_entry.id;

    // NOTE: Can use this to see all available roles
    // const all_roles = await strapi
    //   .query('plugin::users-permissions.role')
    //   .findMany({ where: {} });
    // console.log({ all_roles });

    // Check if the provided email is valid or not.
    const isEmail = emailRegExp.test(params.email);

    if (isEmail) {
      params.email = params.email.toLowerCase();
    } else {
      throw new ValidationError('Please provide a valid email address');
    }

    params.role = role_id;

    const user = await strapi.query('plugin::users-permissions.user').findOne({
      where: { email: params.email },
    });

    if (user && user.provider === params.provider) {
      throw new ApplicationError('Email is already taken');
    }

    if (user && user.provider !== params.provider && settings.unique_email) {
      throw new ApplicationError('Email is already taken');
    }

    try {
      if (!settings.email_confirmation) {
        params.confirmed = true;
      }

      // NOTE: @adig: Adding "populate: role" here
      const user = await strapi
        .query('plugin::users-permissions.user')
        .create({ data: params, populate: ["role"] });

      const sanitizedUser = await sanitizeUser(user, ctx);
      // console.log('User Data', user);

      if (settings.email_confirmation) {
        try {
          await strapi
            .service('plugin::users-permissions.user')
            .sendConfirmationEmail(sanitizedUser);
        } catch (err) {
          throw new ApplicationError(err.message);
        }

        return ctx.send({ user: sanitizedUser });
      }

      const jwt = issueJWT(_.pick(user, ['id']));

      return ctx.send({
        jwt,
        user: sanitizedUser,
      });
    } catch (err) {
      if (_.includes(err.message, 'username')) {
        throw new ApplicationError('Username already taken');
      } else {
        console.error(err);
        throw new ApplicationError('Some error occurred (maybe Email is already taken)');
      }
    }
  }
};
