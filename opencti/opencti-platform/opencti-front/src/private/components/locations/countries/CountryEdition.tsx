import React from 'react';
import CountryEditionContainer, { countryEditionQuery } from './CountryEditionContainer';
import Loader, { LoaderVariant } from '../../../../components/Loader';
import useQueryLoading from '../../../../utils/hooks/useQueryLoading';
import { countryEditionOverviewFocus } from './CountryEditionOverview';
import { CountryEditionContainerQuery } from './__generated__/CountryEditionContainerQuery.graphql';
import useApiMutation from '../../../../utils/hooks/useApiMutation';

const CountryEdition = ({ countryId }: { countryId: string }) => {
  const [commit] = useApiMutation(countryEditionOverviewFocus);
  const handleClose = () => {
    commit({
      variables: {
        id: countryId,
        input: { focusOn: '' },
      },
    });
  };
  const queryRef = useQueryLoading<CountryEditionContainerQuery>(
    countryEditionQuery,
    { id: countryId },
  );
  return (
    <>
      {queryRef && (
        <React.Suspense
          fallback={<Loader variant={LoaderVariant.inElement} />}
        >
          <CountryEditionContainer
            queryRef={queryRef}
            handleClose={handleClose}
          />
        </React.Suspense>
      )}
    </>
  );
};

export default CountryEdition;
