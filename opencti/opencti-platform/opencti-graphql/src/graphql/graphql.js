import { ApolloServer, UserInputError } from 'apollo-server-express';
import { ApolloServerPluginLandingPageGraphQLPlayground, ApolloServerPluginLandingPageDisabled } from 'apollo-server-core';
import { formatError as apolloFormatError } from 'apollo-errors';
import { ApolloArmor } from '@escape.tech/graphql-armor';
import { dissocPath } from 'ramda';
import { createValidation as createAliasBatch } from 'graphql-no-alias';
import ConstraintDirectiveError from 'graphql-constraint-directive/lib/error';
import { constraintDirectiveDocumentation, createApolloQueryValidationPlugin } from 'graphql-constraint-directive';
import { GraphQLError } from 'graphql/error';
import createSchema from './schema';
import conf, { basePath, DEV_MODE, PLAYGROUND_INTROSPECTION_DISABLED, ENABLED_TRACING, PLAYGROUND_ENABLED, GRAPHQL_ARMOR_ENABLED, logApp } from '../config/conf';
import { authenticateUserFromRequest, userWithOrigin } from '../domain/user';
import { ForbiddenAccess, ValidationError } from '../config/errors';
import loggerPlugin from './loggerPlugin';
import telemetryPlugin from './telemetryPlugin';
import httpResponsePlugin from './httpResponsePlugin';
import { executionContext } from '../utils/access';

const createApolloServer = () => {
  let schema = createSchema();
  // graphql-constraint-directive plugin configuration
  const formats = {
    'not-blank': (value) => {
      if (value.length > 0 && value.trim() === '') {
        throw new GraphQLError('Value cannot have only whitespace(s)');
      }
      return true;
    }
  };
  const constraintPlugin = createApolloQueryValidationPlugin({ schema }, { formats });
  schema = constraintDirectiveDocumentation()(schema);
  const apolloPlugins = [loggerPlugin, httpResponsePlugin, constraintPlugin];
  // Protect batch graphql through alias usage
  const batchPermissions = {
    Query: {
      '*': conf.get('app:graphql:batching_protection:query_default') ?? 2, // default value for all queries
      subTypes: conf.get('app:graphql:batching_protection:query_subtypes') ?? 4 // subTypes are used multiple times for schema fetching
    },
    Mutation: {
      '*': conf.get('app:graphql:batching_protection:mutation_default') ?? 1, // default value for all mutations
      token: 1 // force default value for login mutation
    }
  };
  const { validation: batchValidationRule } = createAliasBatch({ permissions: batchPermissions });
  const apolloValidationRules = [batchValidationRule];
  // optional graphql-armor plugin configuration
  // Still disable by default for now as required more testing
  if (GRAPHQL_ARMOR_ENABLED) {
    const armor = new ApolloArmor({
      blockFieldSuggestion: { // It will prevent suggesting fields in case of an erroneous request.
        enabled: true,
      },
      costLimit: { // Blocking too expensive requests (DoS attack attempts).
        maxCost: 10000
      },
      maxAliases: { // Limit the number of aliases in a document.
        enabled: false, // Handled by graphql-no-alias
      },
      maxDepth: { // maxDepth: Limit the depth of a document.
        n: 20,
      },
      maxDirectives: { // Limit the number of directives in a document.
        n: 50,
      },
      maxTokens: { // Limit the number of GraphQL tokens in a document.
        n: 2000,
      }
    });
    const protection = armor.protect();
    apolloPlugins.push(...protection.plugins);
    apolloValidationRules.push(...protection.validationRules);
  }
  // In production mode, we use static from the server
  const playgroundOptions = DEV_MODE ? { settings: { 'request.credentials': 'include' } } : {
    cdnUrl: `${basePath}/static`,
    title: 'OpenCTI Playground',
    faviconUrl: `${basePath}/static/@apollographql/graphql-playground-react@1.7.42/build/static/favicon.png`,
    settings: { 'request.credentials': 'include' }
  };
  const playgroundPlugin = ApolloServerPluginLandingPageGraphQLPlayground(playgroundOptions);
  apolloPlugins.push(PLAYGROUND_ENABLED ? playgroundPlugin : ApolloServerPluginLandingPageDisabled());
  // Schema introspection must be accessible only for auth users.
  const introspectionPatterns = ['__schema {', '__schema(', '__type {', '__type('];
  const secureIntrospectionPlugin = {
    requestDidStart: ({ request, context }) => {
      // Is schema introspection request
      if (introspectionPatterns.some((pattern) => request.query.includes(pattern))) {
        // If introspection explicitly disabled or user is not authenticated
        if (!PLAYGROUND_ENABLED || PLAYGROUND_INTROSPECTION_DISABLED || !context.user) {
          throw ForbiddenAccess('GraphQL introspection not authorized!');
        }
      }
    },
  };
  apolloPlugins.push(secureIntrospectionPlugin);
  if (ENABLED_TRACING) {
    apolloPlugins.push(telemetryPlugin);
  }
  const apolloServer = new ApolloServer({
    schema,
    introspection: true, // Will be disabled by plugin if needed
    persistedQueries: false,
    validationRules: apolloValidationRules,
    async context({ req, res }) {
      const executeContext = executionContext('api');
      executeContext.req = req;
      executeContext.res = res;
      executeContext.synchronizedUpsert = req.headers['synchronized-upsert'] === 'true';
      executeContext.previousStandard = req.headers['previous-standard'];
      executeContext.workId = req.headers['opencti-work-id'];
      try {
        const user = await authenticateUserFromRequest(executeContext, req, res);
        if (user) {
          executeContext.user = userWithOrigin(req, user);
        }
      } catch (error) {
        logApp.error(error);
      }
      return executeContext;
    },
    tracing: DEV_MODE,
    plugins: apolloPlugins,
    formatError: (error) => {
      let e = apolloFormatError(error);
      if (e instanceof UserInputError) {
        if (e.originalError instanceof ConstraintDirectiveError) {
          const { originalError } = e.originalError;
          const { fieldName } = originalError;
          const ConstraintError = ValidationError(fieldName, originalError);
          e = apolloFormatError(ConstraintError);
        }
      }
      // Remove the exception stack in production.
      return DEV_MODE ? e : dissocPath(['extensions', 'exception'], e);
    },
  });
  return { schema, apolloServer };
};

export default createApolloServer;
