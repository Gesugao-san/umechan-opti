import { useState } from 'react';
import { Box } from 'src/components/common/Box';
import { Text, TextVariant } from 'src/components/common/Text';
import { useRadioData } from 'src/services';
import styled from 'styled-components';

const RotatingBox = styled(Box)`
  animation: rotation 20s infinite linear;
  transition: 1s all;

  &:hover {
    animation: none;
    border-radius: 4px;
  }

  @keyframes rotation {
    from {
      transform: rotate(0deg);
    }

    to {
      transform: rotate(360deg);
    }
  }
`;

const Img = styled('img')`
  max-width: 128px;
  transition: 1s all;

  &:hover {
    max-width: 256px;
  }
`;

export const RadioPlayer = ({ url, mount }: { url: string; mount: string }) => {
  const radioData = useRadioData();
  const [isPlaying, setIsPlaying] = useState(false);

  const Comp = isPlaying ? RotatingBox : Box;

  const content = radioData.data?.streaming ? (
    <>
      <Box flexDirection='column' alignItems='center'>
        <Text variant={TextVariant.textBody1}>
          <Text variant={TextVariant.textBodyBold1}>{mount}</Text> [
          {radioData.data?.playlistData?.name}]
        </Text>
      </Box>

      <Box gap='8px' width='100%' justifyContent='center'>
        <Comp borderRadius='100%' overflow='hidden'>
          <Img
            src={`/back-api/radio/thumb/${radioData.data.currentFile}`}
            alt={radioData.data?.fileData?.id3Artist}
            style={{ width: '100%', height: 'auto' }}
          />
        </Comp>
      </Box>

      <Box flexDirection='column' alignItems='center'>
        <Text variant={TextVariant.textBodyBold1}>
          {radioData.data?.fileData?.id3Artist} - {radioData.data?.fileData?.id3Title}
        </Text>
      </Box>

      <audio src={url} id={`radio_${mount}`} />

      <Box gap='8px'>
        <button
          type='button'
          onClick={() => {
            setIsPlaying((flag) => {
              const next = !flag;

              if (next) {
                (document.getElementById(`radio_${mount}`) as HTMLAudioElement)?.play();
              } else {
                (document.getElementById(`radio_${mount}`) as HTMLAudioElement)?.pause();
              }

              return next;
            });
          }}
        >
          {isPlaying ? '⏸' : '▶️'}
        </button>

        <input
          type='range'
          name='volume'
          min='0'
          max='100'
          onChange={(ev) => {
            const value = ev.target.valueAsNumber;
            const tag = document.getElementById(`radio_${mount}`) as HTMLAudioElement;
            tag.volume = value / 100;
          }}
        />
      </Box>
    </>
  ) : (
    <>
      <Text>Радио сейчас оффлайн</Text>
    </>
  );

  return (
    <Box
      flexDirection='column'
      alignItems='center'
      justifyContent='flex-start'
      padding='8px'
      gap='8px'
      width='100%'
    >
      {content}
    </Box>
  );
};
